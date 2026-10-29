'use strict';
// Shared by the Jest and Vitest reporters: every finished test becomes a span named
// `test <full name>` with `test.outcome` / `test.duration_ms`, and, with a project, a
// `test_pass` score (1 passed, 0 failed; skipped tests get no score). Telemetry failures never
// fail the test run.
const wt = require('./index');

/** Client from `opts.client`, else `WT_INGEST_KEY` (+ `WT_PROJECT_ID`); `null` when neither is set. */
function clientFor(opts) {
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
async function reportTests(client, tests) {
  if (!client) return 0;
  let n = 0;
  for (const t of tests) {
    try {
      const end = t.endMs || Date.now();
      const span = client.tracer.startSpan(`test ${t.name}`, { startTime: end - (t.durationMs || 0) });
      span.setAttribute('test.outcome', t.outcome);
      span.setAttribute('test.duration_ms', t.durationMs || 0);
      if (t.outcome === 'failed') {
        span.setStatus({ code: 2, message: String(t.message || 'failed').slice(0, 500) });
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

const OUTCOME = { passed: 'passed', pass: 'passed', failed: 'failed', fail: 'failed' };
const outcome = (s) => OUTCOME[s] || 'skipped';

module.exports = { clientFor, reportTests, outcome };
