// Test optimization for Vitest and Jest, the same contract as the pytest plugin. Opt in with
// WT_TEST_OPTIMIZATION=1 (plus WT_INGEST_KEY, WT_PROJECT_ID and WT_API_URL; WT_API_KEY, when set,
// authenticates the project API calls instead of the ingest key):
// - a global setup asks `POST /v1/projects/{prj}/tests/plan` once and hands the plan to the
//   workers through a file;
// - disabled tests are skipped, and so are tests Test Impact Analysis marks unaffected by the
//   changed files (WT_CHANGED_FILES comma-separated, or `git diff --name-only $WT_GIT_BASE...HEAD`);
// - quarantined tests run, but a failure is turned into a skip (the run stays green) and the
//   reporter records it as a quarantined failure;
// - a test the project has never seen is retried up to `efd_retries` times (early flake detection).
// The reporters upload the results as JUnit (`POST /v1/projects/{prj}/test-runs`) when
// WT_CI_RUN_ID is set, which feeds flaky-test detection and auto-quarantine.
//
// Ids are `<suite>::<file relative to cwd> > <describe>... > <test>`, suite = WT_TEST_SUITE or
// the framework name. Vitest:
//   globalSetup: ['./wt-global.mjs']   // export { default } from '@watchtowerobservability/node/test-plan'
//   setupFiles: ['./wt-setup.ts']      // import { beforeAll, afterEach } from 'vitest';
//                                      // import { vitestSetup } from '@watchtowerobservability/node/test-plan';
//                                      // vitestSetup({ beforeAll, afterEach });
// Jest: globalSetup as above, and testEnvironment: './wt-env.js' with
//   module.exports = require('@watchtowerobservability/node/test-plan').jestEnvironment(require('jest-environment-node').TestEnvironment);
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { clientFor } from './reporter-core.js';
import type { TestRecord } from './reporter-core.js';
import type { Client } from './index.js';

export interface TestPlan {
  quarantined: { id: string; ticket_url?: string | null; owner?: string | null }[];
  disabled: string[];
  skippable: string[];
  new_tests: string[];
  efd_retries: number;
}

/** What the plan says about one test. */
export interface TestDecision {
  skip?: 'disabled' | 'unaffected';
  /** ticket URL (or "no ticket") of a quarantined test */
  quarantined?: string;
  isNew?: boolean;
  retries: number;
}

const PLAN_ENV = 'WT_TEST_PLAN_FILE';

export const suiteName = (framework: string): string => process.env.WT_TEST_SUITE || framework;

export function testId(suite: string, file: string | undefined, names: string[]): string {
  const f = file ? relative(process.cwd(), file).split(sep).join('/') : '';
  return `${suite}::${[f, ...names].filter(Boolean).join(' > ')}`;
}

export function changedFiles(): string[] {
  const env = process.env.WT_CHANGED_FILES;
  if (env) return env.split(',').map((f) => f.trim()).filter(Boolean);
  const base = process.env.WT_GIT_BASE;
  if (!base || base.startsWith('-')) return [];
  try {
    const out = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`, '--'], { encoding: 'utf8', timeout: 30_000 });
    return out.split(/\s+/).filter(Boolean);
  } catch (_e) {
    return [];
  }
}

function apiHeaders(client: Client): Record<string, string> {
  const key = process.env.WT_API_KEY;
  return key ? { Authorization: `Bearer ${key}` } : { ...client.headers };
}

const projectUrl = (client: Client, path: string): string =>
  `${client.apiUrl}/v1/projects/${encodeURIComponent(client.project || '')}/${path}`;

/** The session plan; `null` without a project or when the API is unreachable (then everything runs). */
export async function fetchTestPlan(client: Client | null, tests: string[] = []): Promise<TestPlan | null> {
  if (!client || !client.project) return null;
  try {
    const res = await client.fetch(projectUrl(client, 'tests/plan'), {
      method: 'POST',
      headers: { ...apiHeaders(client), 'Content-Type': 'application/json' },
      body: JSON.stringify({ changed_files: changedFiles(), tests }),
    });
    return res.ok ? ((await res.json()) as TestPlan) : null;
  } catch (_e) {
    return null;
  }
}

let cached: TestPlan | null | undefined;

/** The plan the global setup wrote (workers and reporters), cached per process. */
export function loadPlan(): TestPlan | null {
  if (cached === undefined) {
    const f = process.env[PLAN_ENV];
    try {
      cached = f ? (JSON.parse(readFileSync(f, 'utf8')) as TestPlan) : null;
    } catch (_e) {
      cached = null;
    }
  }
  return cached;
}

/** Vitest/Jest global setup: fetch the plan once and publish it to the workers (which inherit the env). */
export default async function globalSetup(): Promise<void> {
  if (process.env.WT_TEST_OPTIMIZATION !== '1') return;
  const client = clientFor({});
  const plan = await fetchTestPlan(client);
  if (client) await client.shutdown().catch(() => {});
  if (!plan) return;
  // shortcut: the file (a few KB) stays in the OS temp dir; Jest has no teardown return to remove it
  const file = join(mkdtempSync(join(tmpdir(), 'wt-plan-')), 'plan.json');
  writeFileSync(file, JSON.stringify(plan));
  process.env[PLAN_ENV] = file;
  cached = plan;
}

/** Decides per test id; with no plan nothing is skipped or retried. */
export function decider(plan: TestPlan | null): (id: string) => TestDecision {
  if (!plan) return () => ({ retries: 0 });
  const disabled = new Set(plan.disabled || []);
  const skippable = new Set(plan.skippable || []);
  const fresh = new Set(plan.new_tests || []);
  const quarantined = new Map((plan.quarantined || []).map((q) => [q.id, q.ticket_url || 'no ticket']));
  return (id) => {
    const d: TestDecision = { retries: 0 };
    const q = quarantined.get(id);
    if (disabled.has(id)) d.skip = 'disabled';
    else if (skippable.has(id) && q === undefined) d.skip = 'unaffected';
    if (q !== undefined) d.quarantined = q;
    if (fresh.has(id)) {
      d.isNew = true;
      d.retries = Math.max(0, plan.efd_retries || 0);
    }
    return d;
  };
}

// ---------------------------------------------------------------- Vitest

/** The slice of a Vitest task the setup reads and changes. */
export interface PlanTask {
  type?: string;
  name: string;
  mode?: string;
  retry?: number;
  filepath?: string;
  tasks?: PlanTask[];
  meta?: Record<string, unknown>;
  result?: { state?: string; errors?: { message?: string }[] };
}

/** Vitest's `beforeAll`/`afterEach`, passed in so this package does not import Vitest. */
export interface VitestHooks {
  beforeAll(fn: (suite: PlanTask) => unknown): void;
  afterEach(fn: (ctx: { task: PlanTask; skip(note?: string): void }) => unknown): void;
}

/** Applies the plan in a Vitest setup file. Decisions go to `task.meta.wt` for the reporter. */
export function vitestSetup(hooks: VitestHooks): void {
  const plan = loadPlan();
  if (!plan) return;
  const decide = decider(plan);
  const suite = suiteName('vitest');
  const walk = (t: PlanTask, file: string | undefined, names: string[]): void => {
    for (const c of t.tasks || []) {
      const path = [...names, c.name];
      if (c.tasks) {
        walk(c, file, path);
        continue;
      }
      const d = decide(testId(suite, file, path));
      c.meta = { ...c.meta, wt: d };
      if (d.skip && (c.mode === 'run' || c.mode === 'queued')) c.mode = 'skip';
      if (d.retries > (c.retry || 0)) c.retry = d.retries;
    }
  };
  // a setup file's beforeAll runs on the file suite after collection, before any test
  hooks.beforeAll((file) => walk(file, file.filepath, []));
  hooks.afterEach((ctx) => {
    const d = ctx.task.meta?.wt as TestDecision | undefined;
    if (!d?.quarantined || ctx.task.result?.state !== 'fail') return;
    const msg = ctx.task.result.errors?.[0]?.message || 'failed';
    ctx.task.meta = { ...ctx.task.meta, wtQuarantinedFailure: msg.slice(0, 2000) };
    ctx.skip(`quarantined in Watchtower (${d.quarantined})`);
  });
}

// ---------------------------------------------------------------- Jest (jest-circus)

interface CircusBlock {
  name: string;
  parent?: CircusBlock;
  children?: ({ type?: string; name: string } & Partial<CircusTest>)[];
}

interface CircusTest {
  name: string;
  mode?: string;
  status?: string;
  errors: unknown[];
  parent?: CircusBlock;
}

export interface CircusEvent {
  name: string;
  test?: CircusTest;
  describeBlock?: CircusBlock;
}

// a mixin base needs an any[] constructor
type JestEnvBase = new (...args: any[]) => {
  global: Record<string | symbol, unknown>;
  handleTestEvent?(event: CircusEvent, state: unknown): unknown;
};

const RETRY_TIMES = Symbol.for('RETRY_TIMES');

/**
 * Wraps a Jest test environment class so it applies the plan: skips disabled/unaffected tests on
 * `test_start`, raises `jest.retryTimes` for describe blocks holding a new test, and turns a
 * quarantined test's failure into a skip that keeps its failure message (the reporter reads it).
 */
export function jestEnvironment<B extends JestEnvBase>(Base: B): B {
  return class WatchtowerEnvironment extends Base {
    wtFile: string;
    wtDecide = decider(loadPlan());
    wtSuite = suiteName('jest');
    wtRetrySaved: unknown[] = [];

    // any[]: see JestEnvBase
    constructor(...args: any[]) {
      super(...args);
      this.wtFile = (args[1] as { testPath?: string } | undefined)?.testPath || '';
    }

    wtId(test: { name: string; parent?: CircusBlock }): string {
      const names = [test.name];
      for (let b = test.parent; b && b.parent; b = b.parent) names.unshift(b.name);
      return testId(this.wtSuite, this.wtFile, names);
    }

    async handleTestEvent(event: CircusEvent, state: unknown): Promise<void> {
      if (super.handleTestEvent) await super.handleTestEvent(event, state);
      const t = event.test;
      if (event.name === 'test_start' && t) {
        if (this.wtDecide(this.wtId(t)).skip) t.mode = 'skip';
      } else if (event.name === 'test_done' && t && t.errors.length > 0 && this.wtDecide(this.wtId(t)).quarantined) {
        t.status = 'skip'; // reported as pending; the errors stay as failureMessages
      } else if (event.name === 'run_describe_start' && event.describeBlock) {
        const b = event.describeBlock;
        const prev = this.global[RETRY_TIMES];
        this.wtRetrySaved.push(prev);
        // shortcut: Jest retries per describe block, so other failing tests in a block holding a new
        // test are retried too; fine for flake detection, upgrade if circus gets per-test retries
        const n = Math.max(0, ...(b.children || []).filter((c) => c.type === 'test').map((c) => this.wtDecide(this.wtId({ name: c.name, parent: b })).retries));
        if (n > (Number(prev) || 0)) this.global[RETRY_TIMES] = n;
      } else if (event.name === 'run_describe_finish') {
        this.global[RETRY_TIMES] = this.wtRetrySaved.pop();
      }
    }
  };
}

// ---------------------------------------------------------------- JUnit upload

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** One <testsuite>; a test retried k times gets k failed attempts ahead of its final result. */
export function toJunit(suite: string, tests: TestRecord[]): string {
  const prefix = `${suite}::`;
  const cases: string[] = [];
  for (const t of tests) {
    const id = t.id || `${prefix}${t.name}`;
    const name = esc(id.startsWith(prefix) ? id.slice(prefix.length) : id);
    const time = ((t.durationMs || 0) / 1000).toFixed(3);
    const fail = `<failure message="${esc(String(t.message || 'failed').slice(0, 500))}"/>`;
    for (let i = 0; i < (t.attempts || 0); i++) cases.push(`<testcase name="${name}" time="0">${fail}</testcase>`);
    const body = t.outcome === 'failed' ? fail : t.outcome === 'skipped' ? '<skipped/>' : '';
    cases.push(`<testcase name="${name}" time="${time}">${body}</testcase>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites><testsuite name="${esc(suite)}">${cases.join('')}</testsuite></testsuites>\n`;
}

/** Posts the results as JUnit when WT_CI_RUN_ID is set; never throws. */
export async function uploadResults(client: Client | null, suite: string, tests: TestRecord[]): Promise<boolean> {
  const env = process.env;
  const runId = env.WT_CI_RUN_ID;
  if (!client || !client.project || !runId || tests.length === 0) return false;
  const form = new FormData();
  const fields: [string, string | undefined][] = [
    ['run_id', runId],
    ['branch', env.WT_BRANCH || env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || env.CI_COMMIT_REF_NAME],
    ['sha', env.WT_SHA || env.GITHUB_SHA || env.CI_COMMIT_SHA],
    ['suite', suite],
  ];
  for (const [k, v] of fields) if (v) form.append(k, v.slice(0, 200));
  form.append('file', new Blob([toJunit(suite, tests)], { type: 'application/xml' }), 'junit.xml');
  try {
    const res = await client.fetch(projectUrl(client, 'test-runs'), { method: 'POST', headers: apiHeaders(client), body: form });
    return res.ok;
  } catch (_e) {
    return false;
  }
}
