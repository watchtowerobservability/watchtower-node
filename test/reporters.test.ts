import { test, expect } from 'vitest';
import type { ReadableSpan } from '@opentelemetry/sdk-trace';
import * as wt from '../src/index.js';
import Jest from '../src/jest.js';
import Vitest from '../src/vitest.js';

function capture() {
  const spans: ReadableSpan[] = [];
  return {
    spans,
    export: (s: ReadableSpan[], done: (r: { code: number }) => void) => { spans.push(...s); done({ code: 0 }); },
    shutdown: async () => {},
    forceFlush: async () => {},
  };
}

function client() {
  const cap = capture();
  const scores: { name: string; value: number }[] = [];
  const fetch = (async (_u: string, init: { body: string }) => {
    scores.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({}) };
  }) as unknown as typeof globalThis.fetch;
  return { cap, scores, c: new wt.Client({ apiKey: 'k', project: 'p1', apiUrl: 'http://api', exporter: cap, fetch }) };
}

test('jest reporter: one span and score per test', async () => {
  const { cap, scores, c } = client();
  const r = new Jest({}, { client: c });
  r.onTestResult({}, { testResults: [
    { fullName: 'a works', title: 'works', status: 'passed', duration: 5 },
    { fullName: 'a breaks', title: 'breaks', status: 'failed', duration: 3, failureMessages: ['boom'] },
    { fullName: 'a later', title: 'later', status: 'pending', duration: 0 },
  ] });
  await r.onRunComplete();
  const by = Object.fromEntries(cap.spans.map((s) => [s.name, s.attributes['test.outcome']]));
  expect(by).toStrictEqual({ 'test a works': 'passed', 'test a breaks': 'failed', 'test a later': 'skipped' });
  expect(scores.map((s) => [s.name, s.value])).toStrictEqual([['test_pass', 1], ['test_pass', 0]]);
});

test('vitest reporter walks suites and skips the file name', async () => {
  const { cap, c } = client();
  const r = new Vitest({ client: c });
  await r.onFinished([{ type: 'suite', name: 'x.test.js', filepath: '/x.test.js', tasks: [
    { type: 'suite', name: 'calc', tasks: [{ type: 'test', name: 'adds', result: { state: 'pass', duration: 2 } }] },
    { type: 'test', name: 'skipped one', mode: 'skip' },
  ] }]);
  expect(cap.spans.map((s) => s.name).sort()).toStrictEqual(['test calc adds', 'test skipped one']);
});

test('reporters do nothing without a key', async () => {
  delete process.env.WT_INGEST_KEY;
  const r = new Jest({}, {});
  r.onTestResult({}, { testResults: [{ fullName: 't', title: 't', status: 'passed' }] });
  await r.onRunComplete();
});

test('evaluateResume re-runs only failed and missing cases', async () => {
  const { c } = client();
  const ran: number[] = [];
  let failed = false;
  const task = (x: number) => { ran.push(x); if (x === 2 && !failed) { failed = true; throw new Error('flaky'); } return x; };
  const first = await c.evaluate([1, 2, 3], task, {});
  expect(first[1]!.errors.task).toBeTruthy();
  ran.length = 0;
  const again = await c.evaluateResume([1, 2, 3], task, {}, first);
  expect(ran).toStrictEqual([2]);
  expect(again.length).toBe(3);
  expect(again[1]!.errors).toStrictEqual({});
});
