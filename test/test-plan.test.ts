import { test, expect, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import * as wt from '../src/index.js';
import Vitest from '../src/vitest.js';
import Jest from '../src/jest.js';
import { coveredFiles, decider, fetchTestPlan, jestEnvironment, testId, toJunit, uploadCoverage, uploadResults, vitestSetup } from '../src/test-plan.js';
import type { CircusEvent, PlanTask, TestPlan } from '../src/test-plan.js';

const plan: TestPlan = {
  quarantined: [{ id: 'vitest::a.test.ts > calc > flaky', ticket_url: 'https://jira/T-1' }],
  disabled: ['vitest::a.test.ts > calc > off'],
  skippable: ['vitest::a.test.ts > calc > far', 'vitest::a.test.ts > calc > flaky'],
  new_tests: ['vitest::a.test.ts > calc > fresh'],
  efd_retries: 3,
};

afterEach(() => {
  delete process.env.WT_CI_RUN_ID;
  delete process.env.WT_TEST_SUITE;
});

function client(down = false) {
  const spans: ReadableSpan[] = [];
  const calls: { url: string; init: { method?: string; body?: unknown; headers?: Record<string, string> } }[] = [];
  const exporter = {
    export: (s: ReadableSpan[], done: (r: { code: number }) => void) => { spans.push(...s); done({ code: 0 }); },
    shutdown: async () => {},
    forceFlush: async () => {},
  };
  const fetch = (async (url: string, init: { method?: string; body?: unknown }) => {
    if (down) throw new Error('down');
    calls.push({ url, init });
    return { ok: true, json: async () => (url.endsWith('/tests/plan') ? plan : {}) };
  }) as unknown as typeof globalThis.fetch;
  return { spans, calls, c: new wt.Client({ apiKey: 'k', project: 'p1', apiUrl: 'http://api', exporter, fetch }) };
}

test('decider follows the pytest contract', () => {
  const d = decider(plan);
  expect(d('vitest::a.test.ts > calc > off')).toStrictEqual({ retries: 0, skip: 'disabled' });
  expect(d('vitest::a.test.ts > calc > far')).toStrictEqual({ retries: 0, skip: 'unaffected' });
  // quarantined wins over skippable: it runs, failures are ignored
  expect(d('vitest::a.test.ts > calc > flaky')).toStrictEqual({ retries: 0, quarantined: 'https://jira/T-1' });
  expect(d('vitest::a.test.ts > calc > fresh')).toStrictEqual({ retries: 3, isNew: true });
  expect(decider(null)('x')).toStrictEqual({ retries: 0 });
  expect(testId('vitest', join(process.cwd(), 'a.test.ts'), ['calc', 'adds'])).toBe('vitest::a.test.ts > calc > adds');
});

test('fetchTestPlan posts the changed files and survives a dead API', async () => {
  process.env.WT_CHANGED_FILES = 'src/a.ts, src/b.ts';
  const { c, calls } = client();
  expect(await fetchTestPlan(c, ['t1'])).toStrictEqual(plan);
  expect(calls[0]!.url).toBe('http://api/v1/projects/p1/tests/plan');
  expect(JSON.parse(String(calls[0]!.init.body))).toStrictEqual({ changed_files: ['src/a.ts', 'src/b.ts'], tests: ['t1'] });
  delete process.env.WT_CHANGED_FILES;
  expect(await fetchTestPlan(client(true).c)).toBeNull();
});

function withPlan() {
  const dir = mkdtempSync(join(tmpdir(), 'wt-plan-test-'));
  writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan));
  process.env.WT_TEST_PLAN_FILE = join(dir, 'plan.json');
}

test('vitestSetup skips, retries and turns quarantined failures into skips', () => {
  withPlan();
  let before: ((s: PlanTask) => unknown) | undefined;
  let after: ((ctx: { task: PlanTask; skip(note?: string): void }) => unknown) | undefined;
  vitestSetup({ beforeAll: (fn) => { before = fn; }, afterEach: (fn) => { after = fn; } });
  const t = (name: string): PlanTask => ({ type: 'test', name, mode: 'run' });
  const calc: PlanTask = { type: 'suite', name: 'calc', tasks: [t('off'), t('far'), t('flaky'), t('fresh'), t('ok')] };
  const file: PlanTask = { type: 'suite', name: 'a.test.ts', filepath: join(process.cwd(), 'a.test.ts'), tasks: [calc] };
  before!(file);
  const [off, far, flaky, fresh, ok] = calc.tasks!;
  expect([off!.mode, far!.mode, flaky!.mode, ok!.mode]).toStrictEqual(['skip', 'skip', 'run', 'run']);
  expect(fresh!.retry).toBe(3);
  let note = '';
  flaky!.result = { state: 'fail', errors: [{ message: 'boom' }] };
  after!({ task: flaky!, skip: (n) => { note = n || ''; } });
  expect(note).toContain('https://jira/T-1');
  expect(flaky!.meta!.wtQuarantinedFailure).toBe('boom');
  ok!.result = { state: 'fail' };
  after!({ task: ok!, skip: () => { throw new Error('a normal failure must stay a failure'); } });
});

test('vitest reporter sends test.* attributes and uploads JUnit with retries', async () => {
  process.env.WT_CI_RUN_ID = 'r1';
  const { c, spans, calls } = client();
  const f = join(process.cwd(), 'a.test.ts');
  await new Vitest({ client: c }).onFinished([{ type: 'suite', name: 'a.test.ts', filepath: f, tasks: [{ type: 'suite', name: 'calc', tasks: [
    { type: 'test', name: 'flaky', mode: 'skip', result: { state: 'skip' },
      meta: { wt: { retries: 0, quarantined: 'https://jira/T-1' }, wtQuarantinedFailure: 'boom' } },
    { type: 'test', name: 'fresh', meta: { wt: { retries: 3, isNew: true } }, result: { state: 'pass', retryCount: 1 } },
  ] }] }]);
  const by = Object.fromEntries(spans.map((s) => [s.attributes['test.case.name'], s.attributes]));
  const q = by['vitest::a.test.ts > calc > flaky']!;
  expect([q['test.framework'], q['test.suite.name'], q['test.case.result.status'], q['test.quarantined']]).toStrictEqual(['vitest', 'vitest', 'fail', true]);
  const n = by['vitest::a.test.ts > calc > fresh']!;
  expect([n['test.is_new'], n['test.efd.retries'], n['test.is_flaky']]).toStrictEqual([true, 1, true]);
  const up = calls.find((x) => x.url.endsWith('/test-runs'))!;
  const form = up.init.body as FormData;
  expect(form.get('run_id')).toBe('r1');
  const xml = await (form.get('file') as unknown as Blob).text();
  // one failed attempt ahead of the final pass, so the API numbers it as a retry (flake)
  expect(xml.match(/name="a.test.ts &#62; calc &#62; fresh"/g)?.length).toBe(2);
  expect(xml).toContain('<testsuite name="vitest">');
});

test('jestEnvironment applies the plan to circus events', async () => {
  withPlan();
  process.env.WT_TEST_SUITE = 'vitest'; // reuse the plan ids
  class Base {
    global: Record<string | symbol, unknown> = {};
    constructor(..._args: unknown[]) {}
  }
  const Env = jestEnvironment(Base);
  const env = new Env({}, { testPath: join(process.cwd(), 'a.test.ts') }) as Base & { handleTestEvent(e: CircusEvent, s: unknown): Promise<void> };
  const root = { name: 'ROOT_DESCRIBE_BLOCK' };
  const calc = { name: 'calc', parent: root, children: [{ type: 'test', name: 'fresh' }, { type: 'test', name: 'ok' }] };
  const off = { name: 'off', mode: undefined as string | undefined, errors: [], parent: calc };
  await env.handleTestEvent({ name: 'test_start', test: off }, {});
  expect(off.mode).toBe('skip');
  await env.handleTestEvent({ name: 'run_describe_start', describeBlock: calc }, {});
  expect(env.global[Symbol.for('RETRY_TIMES')]).toBe(3);
  await env.handleTestEvent({ name: 'run_describe_finish', describeBlock: calc }, {});
  expect(env.global[Symbol.for('RETRY_TIMES')]).toBeUndefined();
  const flaky = { name: 'flaky', status: 'done', errors: [new Error('boom')], parent: calc };
  await env.handleTestEvent({ name: 'test_done', test: flaky }, {});
  expect(flaky.status).toBe('skip');
  const ok = { name: 'ok', status: 'done', errors: [new Error('real')], parent: calc };
  await env.handleTestEvent({ name: 'test_done', test: ok }, {});
  expect(ok.status).toBe('done');
});

test('jest reporter marks a pending test with failures as a quarantined failure', async () => {
  withPlan();
  process.env.WT_TEST_SUITE = 'vitest';
  const { c, spans } = client();
  const r = new Jest({}, { client: c });
  r.onTestResult({}, { testFilePath: join(process.cwd(), 'a.test.ts'), testResults: [
    { ancestorTitles: ['calc'], title: 'flaky', status: 'pending', failureMessages: ['boom'] },
    { ancestorTitles: ['calc'], title: 'fresh', status: 'passed', invocations: 3 },
  ] });
  await r.onRunComplete();
  const by = Object.fromEntries(spans.map((s) => [s.attributes['test.case.name'], s.attributes]));
  expect(by['vitest::a.test.ts > calc > flaky']!['test.quarantined']).toBe(true);
  expect(by['vitest::a.test.ts > calc > fresh']!['test.efd.retries']).toBe(2);
});

test('toJunit escapes and uploads only with a run id', async () => {
  const x = toJunit('s', [{ name: 'a<b', outcome: 'skipped' }, { name: 'c', outcome: 'failed', message: '"x"' }]);
  expect(x).toContain('<testcase name="a&#60;b" time="0.000"><skipped/></testcase>');
  expect(x).toContain('<failure message="&#34;x&#34;"/>');
  const { c } = client();
  expect(await uploadResults(c, 's', [{ name: 'c', outcome: 'passed' }])).toBe(false);
});

test('coverage recording: istanbul hits per test file, uploaded as the coverage map', async () => {
  const root = join(tmpdir(), 'repo');
  const cov = {
    [join(root, 'src/a.ts')]: { path: join(root, 'src/a.ts'), s: { 0: 1, 1: 0 } },
    [join(root, 'src/unused.ts')]: { s: { 0: 0 } },
    [join(tmpdir(), 'elsewhere.ts')]: { s: { 0: 3 } },
  };
  expect(coveredFiles(cov, root)).toStrictEqual(['src/a.ts']);
  expect(coveredFiles(null, root)).toStrictEqual([]);
  const calls: { url: string; body: string }[] = [];
  const fetchImpl = (async (url: string, init: { body: string }) => {
    calls.push({ url, body: init.body });
    return { ok: true };
  }) as unknown as typeof globalThis.fetch;
  expect(await uploadCoverage('a.test.ts', ['vitest::a.test.ts > x'], cov, fetchImpl)).toBe(false); // no env
  Object.assign(process.env, { WT_API_URL: 'http://api/', WT_PROJECT_ID: 'p1', WT_API_KEY: 'k', WT_SHA: 'abc' });
  try {
    expect(await uploadCoverage(join(process.cwd(), 'a.test.ts'), ['vitest::a.test.ts > x', 'vitest::a.test.ts > x'], {}, fetchImpl)).toBe(true);
    expect(calls[0]!.url).toBe('http://api/v1/projects/p1/tests/coverage-map');
    const body = JSON.parse(calls[0]!.body);
    expect(body.sha).toBe('abc');
    expect(body.tests).toHaveLength(1);
    expect(body.tests[0].suite).toBe('vitest');
    expect(body.tests[0].test).toBe('a.test.ts > x');
    expect(body.tests[0].files.some((f: string) => f.endsWith('a.test.ts'))).toBe(true);
  } finally {
    for (const k of ['WT_API_URL', 'WT_PROJECT_ID', 'WT_API_KEY', 'WT_SHA']) delete process.env[k];
  }
});
