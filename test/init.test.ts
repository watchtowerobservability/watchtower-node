import { test, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SpanExporter, ReadableSpan } from '@opentelemetry/sdk-trace-base';
import * as wt from '../src/index.js';
import { SpoolExporter, spoolLogs } from '../src/buffer.js';
import type { LogRecordExporter, ReadableLogRecord } from '@opentelemetry/sdk-logs';

function capture() {
  const spans: ReadableSpan[] = [];
  return {
    spans,
    export: (s: ReadableSpan[], done: (r: { code: number }) => void) => { spans.push(...s); done({ code: 0 }); },
    shutdown: async () => {},
    forceFlush: async () => {},
  };
}

test('exports with key header', () => {
  const c = new wt.Client({ apiKey: 'test-key-not-real', endpoint: 'http://x:4318/', exporter: capture() });
  expect(c.headers).toStrictEqual({ Authorization: 'Bearer test-key-not-real' });
  expect(c.endpoint).toBe('http://x:4318');
});

test('drops wt.* resource attributes', () => {
  expect(wt.safeResource({ 'wt.tenant_id': 'x', env: 'p' })).toStrictEqual({ env: 'p' });
});

test('observe and redact', async () => {
  const cap = capture();
  const c = wt.init({ apiKey: 'k', exporter: cap, redact: (k, v) => (k === 'secret' ? '[x]' : v) });
  const f = c.observe('op', () => wt.trace.getActiveSpan()!.setAttribute('secret', 'hunter2'));
  f();
  await wt.shutdown();
  expect(cap.spans[0]!.name).toBe('op');
  expect(cap.spans[0]!.attributes.secret).toBe('[x]');
});

test('evaluate tolerates scorer errors and posts scores', async () => {
  const calls: [string, Record<string, unknown>][] = [];
  const fetch = (async (url: string, init: { body: string }) => {
    calls.push([url, JSON.parse(init.body)]);
    return { ok: true, json: async () => ({}) };
  }) as unknown as typeof globalThis.fetch;
  const c = new wt.Client({ apiKey: 'k', project: 'p1', apiUrl: 'http://api', exporter: capture(), fetch });
  const rows = await c.evaluate([{ input: 1 }], (x: number) => x * 2, { ok: (_, o) => o === 2, boom: () => { throw new Error('bad'); } });
  expect(rows[0]!.scores).toStrictEqual({ ok: true });
  expect(rows[0]!.errors.boom).toBe('bad');
  expect(calls[0]![0]).toBe('http://api/v1/projects/p1/llm/scores');
  expect(calls[0]![1].source).toBe('sdk');
});

test('failed export is spooled and capped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-spool-'));
  const failing = { export: (_s: ReadableSpan[], done: (r: { code: number }) => void) => done({ code: 1 }), shutdown: async () => {} };
  const offline = (async () => { throw new Error('offline'); }) as unknown as typeof globalThis.fetch;
  const s = new SpoolExporter(failing as SpanExporter, dir, 'http://x', {}, offline, { maxFiles: 2, encode: () => Buffer.from('{}') });
  return new Promise<void>((resolve) => {
    let n = 0;
    const next = (): void => {
      if (n++ < 4) s.export([], next);
      else { expect(fs.readdirSync(dir).length).toBe(2); resolve(); }
    };
    next();
  });
});

test('failed log export is spooled and replayed to /v1/logs once the endpoint is back', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-spool-logs-'));
  let up = false;
  const posted: string[] = [];
  const fetch = (async (url: string) => {
    if (!up) throw new Error('offline');
    posted.push(url);
    return { ok: true };
  }) as unknown as typeof globalThis.fetch;
  const failing = { export: (_l: ReadableLogRecord[], done: (r: { code: number }) => void) => done({ code: up ? 0 : 1 }), shutdown: async () => {} };
  const s = spoolLogs(failing as unknown as LogRecordExporter, dir, 'http://x/v1/logs', {}, fetch, { maxFiles: 3 });
  const exp = (): Promise<void> => new Promise((r) => s.export([], () => r()));
  // an empty batch still encodes to a valid OTLP/JSON logs request
  await exp(); await exp();
  expect(fs.readdirSync(dir)).toHaveLength(2);
  up = true;
  await exp();
  expect(posted).toEqual(['http://x/v1/logs', 'http://x/v1/logs']);
  expect(fs.readdirSync(dir)).toHaveLength(0);
});
