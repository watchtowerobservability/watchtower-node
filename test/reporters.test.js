'use strict';
const test = require('node:test');
const assert = require('node:assert');
const wt = require('../src');
const Jest = require('../src/jest');
const Vitest = require('../src/vitest');

function capture() {
  const spans = [];
  return { spans, export: (s, done) => { spans.push(...s); done({ code: 0 }); }, shutdown: async () => {}, forceFlush: async () => {} };
}

function client() {
  const cap = capture();
  const scores = [];
  const fetch = async (_u, init) => { scores.push(JSON.parse(init.body)); return { ok: true, json: async () => ({}) }; };
  return { cap, scores, c: new wt.Client({ apiKey: 'k', project: 'p1', apiUrl: 'http://api', exporter: cap, fetch }) };
}

test('jest reporter: one span and score per test', async () => {
  const { cap, scores, c } = client();
  const r = new Jest({}, { client: c });
  r.onTestResult({}, { testResults: [
    { fullName: 'a works', status: 'passed', duration: 5 },
    { fullName: 'a breaks', status: 'failed', duration: 3, failureMessages: ['boom'] },
    { fullName: 'a later', status: 'pending', duration: 0 },
  ] });
  await r.onRunComplete();
  const by = Object.fromEntries(cap.spans.map((s) => [s.name, s.attributes['test.outcome']]));
  assert.deepStrictEqual(by, { 'test a works': 'passed', 'test a breaks': 'failed', 'test a later': 'skipped' });
  assert.deepStrictEqual(scores.map((s) => [s.name, s.value]), [['test_pass', 1], ['test_pass', 0]]);
});

test('vitest reporter walks suites and skips the file name', async () => {
  const { cap, c } = client();
  const r = new Vitest({ client: c });
  await r.onFinished([{ type: 'suite', name: 'x.test.js', filepath: '/x.test.js', tasks: [
    { type: 'suite', name: 'calc', tasks: [{ type: 'test', name: 'adds', result: { state: 'pass', duration: 2 } }] },
    { type: 'test', name: 'skipped one', mode: 'skip' },
  ] }]);
  assert.deepStrictEqual(cap.spans.map((s) => s.name).sort(), ['test calc adds', 'test skipped one']);
});

test('reporters do nothing without a key', async () => {
  delete process.env.WT_INGEST_KEY;
  const r = new Jest({}, {});
  r.onTestResult({}, { testResults: [{ fullName: 't', status: 'passed' }] });
  await r.onRunComplete();
});

test('evaluateResume re-runs only failed and missing cases', async () => {
  const { c } = client();
  const ran = [];
  let failed = false;
  const task = (x) => { ran.push(x); if (x === 2 && !failed) { failed = true; throw new Error('flaky'); } return x; };
  const first = await c.evaluate([1, 2, 3], task, {});
  assert.ok(first[1].errors.task);
  ran.length = 0;
  const again = await c.evaluateResume([1, 2, 3], task, {}, first);
  assert.deepStrictEqual(ran, [2]);
  assert.strictEqual(again.length, 3);
  assert.deepStrictEqual(again[1].errors, {});
});
