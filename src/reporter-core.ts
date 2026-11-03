// Shared by the Jest and Vitest reporters: every finished test becomes a span named
// `test <full name>` with `test.outcome` / `test.duration_ms`, and, with a project, a
// `test_pass` score (1 passed, 0 failed; skipped tests get no score). Telemetry failures never
// fail the test run.
import { SpanStatusCode } from '@opentelemetry/api';
import * as wt from './index.js';
import type { Client, InitOptions } from './index.js';

export interface ReporterOptions {
  client?: Client;
  apiKey?: string;
  serviceName?: string;
  /** Extra options passed to `init` when the reporter creates its own client. */
  init?: InitOptions;
}

export type TestOutcome = 'passed' | 'failed' | 'skipped';

export interface TestRecord {
  name: string;
  outcome: TestOutcome;
  durationMs?: number;
  message?: string;
  endMs?: number;
  /** `suite::file > describe > test` (see test-plan.ts) */
  id?: string;
  /** ticket of a quarantined test; its failure did not fail the run */
  quarantined?: string;
  /** a test the project had never seen (early flake detection) */
  isNew?: boolean;
  /** failed attempts before the final result (retries) */
  attempts?: number;
}

/** Client from `opts.client`, else `WT_INGEST_KEY` (+ `WT_PROJECT_ID`); `null` when neither is set. */
export function clientFor(opts?: ReporterOptions): Client | null {
  const o = opts || {};
  if (o.client) return o.client;
  const apiKey = o.apiKey || process.env.WT_INGEST_KEY;
  if (!apiKey) return null;
  return wt.init({ apiKey, serviceName: o.serviceName || 'tests', ...o.init });
}

/**
 * tests: [{ name, outcome: 'passed'|'failed'|'skipped', durationMs, message?, endMs? }]
 * Spans are created after the fact, so start/end times are set explicitly.
 */
export async function reportTests(client: Client | null, tests: TestRecord[], framework = 'test'): Promise<number> {
  if (!client) return 0;
  let n = 0;
  for (const t of tests) {
    try {
      const end = t.endMs || Date.now();
      const span = client.tracer.startSpan(`test ${t.name}`, { startTime: end - (t.durationMs || 0) });
      span.setAttribute('test.outcome', t.outcome);
      span.setAttribute('test.duration_ms', t.durationMs || 0);
      // OTel test semconv plus the attributes the pytest plugin sets
      const id = t.id || t.name;
      span.setAttribute('test.framework', framework);
      span.setAttribute('test.suite.name', id.includes('::') ? id.slice(0, id.indexOf('::')) : framework);
      span.setAttribute('test.case.name', id);
      span.setAttribute('test.case.result.status', t.outcome === 'passed' ? 'pass' : t.outcome === 'failed' ? 'fail' : 'skip');
      if (t.quarantined) span.setAttribute('test.quarantined', true);
      if (t.isNew) {
        span.setAttribute('test.is_new', true);
        span.setAttribute('test.efd.retries', t.attempts || 0);
        span.setAttribute('test.is_flaky', (t.attempts || 0) > 0 && t.outcome === 'passed');
      }
      if (t.outcome === 'failed') {
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(t.message || 'failed').slice(0, 500) });
      }
      const traceId = span.spanContext().traceId;
      span.end(end);
      n += 1;
      if (client.project && t.outcome !== 'skipped') {
        await client.score(traceId, t.outcome === 'passed' ? 1 : 0, { name: 'test_pass', comment: t.name });
      }
    } catch (_e) { /* telemetry down must not fail tests */ }
  }
  try { await client.provider.forceFlush(); } catch (_e) { /* same */ }
  return n;
}

const OUTCOME: Record<string, TestOutcome> = { passed: 'passed', pass: 'passed', failed: 'failed', fail: 'failed' };
export const outcome = (s?: string): TestOutcome => OUTCOME[s as string] || 'skipped';
