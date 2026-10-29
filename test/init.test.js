'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const wt = require('../src');
const { SpoolExporter } = require('../src/buffer');

function capture() {
  const spans = [];
  return { spans, export: (s, done) => { spans.push(...s); done({ code: 0 }); }, shutdown: async () => {}, forceFlush: async () => {} };
}

test('exports with key header', () => {
  const c = new wt.Client({ apiKey: 'test-key-not-real', endpoint: 'http://x:4318/', exporter: capture() });
  assert.deepStrictEqual(c.headers, { Authorization: 'Bearer test-key-not-real' });
  assert.strictEqual(c.endpoint, 'http://x:4318');
});

test('drops wt.* resource attributes', () => {
  assert.deepStrictEqual(wt.safeResource({ 'wt.tenant_id': 'x', env: 'p' }), { env: 'p' });
});

test('observe and redact', async () => {
  const cap = capture();
  const c = wt.init({ apiKey: 'k', exporter: cap, redact: (k, v) => (k === 'secret' ? '[x]' : v) });
  const f = c.observe('op', () => wt.trace.getActiveSpan().setAttribute('secret', 'hunter2'));
  f();
  await wt.shutdown();
  assert.strictEqual(cap.spans[0].name, 'op');
  assert.strictEqual(cap.spans[0].attributes.secret, '[x]');
});

test('evaluate tolerates scorer errors and posts scores', async () => {
  const calls = [];
  const fetch = async (url, init) => { calls.push([url, JSON.parse(init.body)]); return { ok: true, json: async () => ({}) }; };
  const c = new wt.Client({ apiKey: 'k', project: 'p1', apiUrl: 'http://api', exporter: capture(), fetch });
  const rows = await c.evaluate([{ input: 1 }], (x) => x * 2, { ok: (_, o) => o === 2, boom: () => { throw new Error('bad'); } });
  assert.deepStrictEqual(rows[0].scores, { ok: true });
  assert.strictEqual(rows[0].errors.boom, 'bad');
  assert.strictEqual(calls[0][0], 'http://api/v1/projects/p1/llm/scores');
  assert.strictEqual(calls[0][1].source, 'sdk');
});

test('failed export is spooled and capped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-spool-'));
  const failing = { export: (_s, done) => done({ code: 1 }), shutdown: async () => {} };
  const s = new SpoolExporter(failing, dir, 'http://x', {}, async () => { throw new Error('offline'); }, { maxFiles: 2, encode: () => Buffer.from('{}') });
  return new Promise((resolve) => {
    let n = 0;
    const next = () => (n++ < 4 ? s.export([], next) : (assert.strictEqual(fs.readdirSync(dir).length, 2), resolve()));
    next();
  });
});
