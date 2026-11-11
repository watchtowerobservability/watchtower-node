import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReadableSpan } from '@opentelemetry/sdk-trace';
import * as wt from '../src/index.js';
import * as loader from '../src/load.js';
import { otelEnv, parseKv } from '../src/env.js';
import { makeRegister, register } from '../src/integrations/next.js';

const spans: ReadableSpan[] = [];
const logs: { body?: unknown; attributes?: Record<string, unknown>; resource?: { attributes: Record<string, unknown> } }[] = [];
const ok = (done: (r: { code: number }) => void) => done({ code: 0 });
const SECRET = 'sk_live_XXXXXXXXXXXXXXXX';
const scrub = (_k: string, v: unknown) => (typeof v === 'string' ? v.replaceAll(SECRET, '[x]') : v);

// one init for the file: the OTel globals can be set once per process
const c = wt.init({
  apiKey: 'k', captureProcessErrors: false, instrument: false, redact: scrub,
  exporter: { export: (s: ReadableSpan[], d: (r: { code: number }) => void) => { spans.push(...s); ok(d); }, shutdown: async () => {}, forceFlush: async () => {} },
  logExporter: { export: (l: typeof logs, d: (r: { code: number }) => void) => { logs.push(...l); ok(d); }, shutdown: async () => {}, forceFlush: async () => {} },
});

test('redact covers span name, status message, exception event attributes and log bodies', async () => {
  c.tracer.startActiveSpan(`GET /pay/${SECRET}`, (span) => {
    wt.captureException(new Error(`token ${SECRET}`));
    span.end();
  });
  c.log('info', `body ${SECRET}`, { a: SECRET });
  await wt.flush();
  const s = spans.find((x) => x.name.startsWith('GET /pay'))!;
  const dump = JSON.stringify({ name: s.name, status: s.status, events: s.events.map((e) => e.attributes) });
  expect(dump).not.toContain(SECRET);
  expect(s.events[0]!.attributes!['exception.message']).toBe('token [x]');
  expect(String(s.events[0]!.attributes!['exception.stacktrace'])).toContain('[x]');
  expect(JSON.stringify(logs)).not.toContain(SECRET);
});

test('the Next entry takes options and keeps the default register', () => {
  expect(typeof makeRegister({ redact: scrub })).toBe('function');
  expect(typeof register).toBe('function');
});

test('OTEL_* env parsing', () => {
  expect(parseKv('a=1, b=x%20y,bad')).toStrictEqual({ a: '1', b: 'x y' });
  const e = otelEnv({
    OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318', OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer abc,x-a=1',
    OTEL_SERVICE_NAME: 'svc', OTEL_RESOURCE_ATTRIBUTES: 'service.version=2.0.0,deployment.environment.name=prod',
  });
  expect(e).toMatchObject({ endpoint: 'http://c:4318', bearer: 'abc', headers: { 'x-a': '1' }, serviceName: 'svc' });
  expect(e.resource['service.version']).toBe('2.0.0');
});

test('OTEL_* are fallbacks after WT_*: endpoint, key, service, release', () => {
  const saved = { ...process.env };
  try {
    for (const k of Object.keys(process.env)) if (/^(WT_|OTEL_)/.test(k)) delete process.env[k];
    Object.assign(process.env, {
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel:4318/', OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer fromotel',
      OTEL_SERVICE_NAME: 'otel-svc', OTEL_RESOURCE_ATTRIBUTES: 'service.version=9.9.9',
    });
    const exporter = { export: (_s: unknown, d: (r: { code: number }) => void) => ok(d), shutdown: async () => {} } as never;
    const a = new wt.Client({ exporter, logs: false, metrics: false });
    expect(a.endpoint).toBe('http://otel:4318');
    expect(a.headers.Authorization).toBe('Bearer fromotel');
    expect(a.resource.attributes['service.name']).toBe('otel-svc');
    expect(a.resource.attributes['service.version']).toBe('9.9.9');
    process.env.WT_SERVICE = 'wt-svc';
    process.env.WT_RELEASE = '1.0.0';
    process.env.WT_OTLP_ENDPOINT = 'http://wt:4318';
    const b = new wt.Client({ exporter, logs: false, metrics: false });
    expect([b.endpoint, b.resource.attributes['service.name'], b.resource.attributes['service.version']]).toStrictEqual(['http://wt:4318', 'wt-svc', '1.0.0']);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test('an explicit exporter keeps the default log and metric exporters on', () => {
  const exporter = { export: (_s: unknown, d: (r: { code: number }) => void) => ok(d), shutdown: async () => {} } as never;
  const on = new wt.Client({ apiKey: 'k', exporter, logs: true, metrics: true });
  expect(on.meterProvider).toBeDefined();
  void on.shutdown().catch(() => {});
});

test('ESM load.js is the compiled load.ts: exports load and need, no hand-written twin', () => {
  expect(typeof loader.load).toBe('function');
  expect(typeof loader.need).toBe('function');
  const build = readFileSync(join(__dirname, '../scripts/build.mjs'), 'utf8');
  expect(build).not.toMatch(/export function load/);
  const src = readFileSync(join(__dirname, '../src/load.ts'), 'utf8');
  expect(src).not.toMatch(/require\('@opentelemetry/); // no literal peer names: webpack must not follow optional peers (V-17)
  expect(src).not.toMatch(/[^.\w]require\(id\)/); // a bare require(id) is webpack's "Critical dependency"
  expect(() => loader.need('@opentelemetry/not-installed-pkg')).toThrow();
});
