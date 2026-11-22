import { afterEach, expect, test, vi } from 'vitest';
import * as wt from '../src/index.js';
import { StatusLine } from '../src/diagnostics.js';
import { markDeploy } from '../src/deploy.js';
import { INSTRUMENTATION_PKGS } from '../src/instrument.js';

const ok = { export: (_s: unknown, d: (r: { code: number }) => void) => d({ code: 0 }), shutdown: async () => {}, forceFlush: async () => {} } as never;
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

test('WT-B0: key without endpoint defaults to the hosted ingest URL', () => {
  vi.stubEnv('WT_OTLP_ENDPOINT', ''); vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', '');
  const c = new wt.Client({ apiKey: 'k', exporter: ok });
  expect(c.endpoint).toBe('https://ingest.watchtowerops.net');
});

test('WT-B0: a failed trace export warns once, naming the endpoint and WT_OTLP_ENDPOINT', () => {
  const warn = vi.fn();
  const l = new StatusLine({ service: 'api', endpoint: 'http://localhost:4318' }, () => {}, warn);
  l.record('traces', 1, { code: 1, error: new Error('fetch failed') });
  l.record('traces', 1, { code: 1, error: new Error('fetch failed') });
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls[0][0]).toMatch(/localhost:4318.*WT_OTLP_ENDPOINT/);
});

test('WT-B1: init logs what it instrumented and records it as a resource attribute', () => {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  const c = wt.init({ apiKey: 'k', captureProcessErrors: false, exporter: ok });
  const names = c.resource.attributes['watchtower.instrumentations'] as string[];
  expect(names).toEqual(expect.arrayContaining(['http', 'undici', 'pg', 'ioredis']));
  expect(info).toHaveBeenCalledWith(`[watchtower] instrumented: ${names.join(', ')}`);
  expect(INSTRUMENTATION_PKGS).toContain('@opentelemetry/instrumentation-undici');
});

test('WT-B1: WT_INSTRUMENT_LOG=off silences the instrumented line', () => {
  vi.stubEnv('WT_INSTRUMENT_LOG', 'off');
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  wt.init({ apiKey: 'k', captureProcessErrors: false, exporter: ok });
  expect(info.mock.calls.some((a) => String(a[0]).includes('instrumented:'))).toBe(false);
});

test('WT-I6: markDeploy posts the release and an idempotent deployment, once, and never throws', async () => {
  vi.stubEnv('WT_DEPLOY_KEY', 'ci-key'); vi.stubEnv('WT_API_URL', 'https://api.test/');
  const calls: string[] = [];
  const fetch = (async (u: string, i: { method: string; body?: string }) => {
    calls.push(`${i.method} ${u} ${i.body ?? ''}`);
    return { ok: true, status: 200, json: async () => ({ data: [{ id: 'env1', name: 'production' }] }) };
  }) as never;
  const c = { project: 'prj_1', fetch, resource: { attributes: { 'service.version': 'v1', 'service.name': 'web' } } } as never;
  expect(await markDeploy(c)).toMatch(/marked deploy web@v1/);
  expect(calls[0]).toBe('POST https://api.test/v1/projects/prj_1/releases {"version":"v1"}');
  expect(calls[2]).toContain('"external_id":"v1-web"');
  expect(calls[2]).toContain('"env_id":"env1"');
  expect(await markDeploy(c)).toBeUndefined(); // once per release
  const bad = { project: 'p', fetch: (async () => { throw new Error('down'); }) as never, resource: { attributes: { 'service.version': 'v2', 'service.name': 'web' } } } as never;
  expect(await markDeploy(bad)).toBe('deploy marker failed: down');
});
