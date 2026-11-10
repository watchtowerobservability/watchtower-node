import { test, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { context, trace } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace';
import * as wt from '../src/index.js';
import { VERSION } from '../src/version.js';
import { startDbSpan } from '../src/integrations/db.js';
import { checkin } from '../src/checkin.js';
import { installSignalFlush } from '../src/shutdown.js';
import { isNextInternal, nextInternalsFilter } from '../src/integrations/next.js';
import { tunnelHandler } from '../src/integrations/next-tunnel.js';
import { uploadSourcemaps, withWatchtower } from '../src/integrations/next-build.js';

type Done = (r: { code: number }) => void;
const spans: ReadableSpan[] = [];
const client = wt.init({
  apiKey: 'test-key-not-real', captureProcessErrors: false, logs: false, metrics: false, instrument: false,
  exporter: { export: (s: ReadableSpan[], done: Done) => { spans.push(...s); done({ code: 0 }); }, shutdown: async () => {}, forceFlush: async () => {} },
});

test('package version constant matches package.json', () => {
  expect(VERSION).toBe(JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8')).version);
});

test('resource carries telemetry.sdk.* and the distro', () => {
  const a = client.resource.attributes;
  expect(a['telemetry.sdk.name']).toBe('opentelemetry');
  expect(a['telemetry.sdk.language']).toBe('nodejs');
  expect(String(a['telemetry.sdk.version'])).toMatch(/^\d/);
  expect(a['telemetry.distro.name']).toBe('watchtower');
  expect(a['telemetry.distro.version']).toBe(VERSION);
});

test('requireParent: no span without an active parent (default), one with it, always with requireParent:false', () => {
  const op = { system: 'sqlite', sql: 'SELECT 1' };
  expect(startDbSpan(op, undefined, context.active()).isRecording()).toBe(false);
  expect(startDbSpan(op, { requireParent: false }, context.active()).isRecording()).toBe(true);
  trace.getTracer('t').startActiveSpan('request', (parent) => {
    const s = startDbSpan(op, undefined, context.active());
    expect(s.isRecording()).toBe(true);
    s.end();
    parent.end();
  });
});

test('checkin sends in_progress then ok/error with duration and passes the result and errors through', async () => {
  const calls: string[] = [];
  const f = (async (u: string) => { calls.push(u); return new Response('{}'); }) as unknown as typeof fetch;
  const c = { endpoint: 'http://e', headers: { Authorization: 'Bearer k' }, fetch: f };
  expect(await checkin(c, 'nightly job', () => 7)).toBe(7);
  await expect(checkin(c, 'j', () => { throw new Error('x'); })).rejects.toThrow('x');
  expect(calls[0]).toBe('http://e/v1/checkins/nightly%20job?status=in_progress');
  expect(calls[1]).toMatch(/^http:\/\/e\/v1\/checkins\/nightly%20job\?status=ok&duration_ms=\d+$/);
  expect(calls[3]).toMatch(/status=error&duration_ms=/);
});

test('signal flush: flushes, then re-sends the signal only when it was the sole listener', async () => {
  const listeners: Record<string, (() => void)[]> = {};
  const kill = vi.fn();
  const proc = {
    pid: 42, kill,
    on: (e: string, l: () => void) => { (listeners[e] ??= []).push(l); },
    off: (e: string, l: () => void) => { listeners[e] = (listeners[e] ?? []).filter((x) => x !== l); },
    listenerCount: (e: string) => (listeners[e] ?? []).length,
  };
  const flush = vi.fn(async () => {});
  installSignalFlush(flush, 50, proc);
  listeners.SIGTERM![0]!();
  await new Promise((r) => setTimeout(r, 10));
  expect(flush).toHaveBeenCalledTimes(1);
  expect(kill).toHaveBeenCalledWith(42, 'SIGTERM');
  proc.on('SIGINT', () => {}); // an app handler decides how the process ends
  listeners.SIGINT![0]!();
  await new Promise((r) => setTimeout(r, 10));
  expect(kill).toHaveBeenCalledTimes(1);
});

const nextSpan = (name: string, type: string | undefined, extra: Partial<ReadableSpan> = {}) =>
  ({ name, kind: 0, status: { code: 0 }, attributes: type ? { 'next.span_type': type } : {}, ...extra }) as unknown as ReadableSpan;

test('nextInternals: drop / sample / keep; requests, route handlers, fetch and errors always kept', () => {
  const internal = nextSpan('load route module', 'NextNodeServer.loadModule');
  expect(isNextInternal(internal)).toBe(true);
  expect(isNextInternal(nextSpan('GET /x', 'BaseServer.handleRequest', { kind: 1 }))).toBe(false);
  expect(isNextInternal(nextSpan('executing api route (app) /x', 'AppRouteRouteHandlers.runHandler'))).toBe(false);
  expect(isNextInternal(nextSpan('fetch GET https://a.test/', 'AppRender.fetch', { kind: 2 }))).toBe(false);
  expect(isNextInternal(nextSpan('POST server action submit', 'x'))).toBe(false);
  expect(isNextInternal(nextSpan('start response', 'NextNodeServer.startResponse', { status: { code: 2 } } as never))).toBe(false);
  expect(isNextInternal(nextSpan('db', undefined))).toBe(false);
  expect(nextInternalsFilter('drop')(internal)).toBe(false);
  expect(nextInternalsFilter('keep')(internal)).toBe(true);
  expect(nextInternalsFilter('sample', 0.1, () => 0.05)(internal)).toBe(true);
  expect(nextInternalsFilter('sample', 0.1, () => 0.5)(internal)).toBe(false);
});

test('withWatchtower turns on browser source maps, also for function configs', async () => {
  expect(withWatchtower({ a: 1 }, { sourcemaps: true })).toEqual({ a: 1, productionBrowserSourceMaps: true });
  expect(withWatchtower({ a: 1 })).toEqual({ a: 1 });
  const fn = withWatchtower(() => ({ b: 2 }), { sourcemaps: true }) as () => Promise<unknown>;
  expect(await fn()).toEqual({ b: 2, productionBrowserSourceMaps: true });
});

test('uploadSourcemaps uploads each map under _next/static, then deletes them', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-next-'));
  fs.mkdirSync(path.join(dir, 'chunks'));
  fs.writeFileSync(path.join(dir, 'chunks', 'a.js.map'), '{"version":3}');
  fs.writeFileSync(path.join(dir, 'chunks', 'a.js'), 'x');
  const urls: string[] = [];
  const f = (async (u: string, init: RequestInit) => { urls.push(`${init.method} ${u} ${(init.headers as Record<string, string>).authorization}`); return new Response('{}'); }) as unknown as typeof fetch;
  const r = await uploadSourcemaps({ dir, apiKey: 'k', project: 'p1', release: 'r1', apiUrl: 'http://api', fetch: f });
  expect(r.uploaded).toBe(1);
  expect(urls[0]).toBe('POST http://api/v1/projects/p1/releases Bearer k');
  expect(urls[1]).toBe('POST http://api/v1/projects/p1/artifacts?kind=sourcemap&name=_next%2Fstatic%2Fchunks%2Fa.js.map&release=r1 Bearer k');
  expect(fs.existsSync(path.join(dir, 'chunks', 'a.js.map'))).toBe(false);
  expect(fs.existsSync(path.join(dir, 'chunks', 'a.js'))).toBe(true);
});

test('tunnel forwards only RUM paths and the publishable key, caps the body', async () => {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const f = (async (url: string, init: RequestInit) => { seen.push({ url, headers: init.headers as Record<string, string> }); return new Response('{"ok":1}', { headers: { 'content-type': 'application/json' } }); }) as unknown as typeof fetch;
  const { POST } = tunnelHandler({ endpoint: 'http://edge/', maxBodyBytes: 10, fetch: f });
  const ok = await POST(new Request('http://app/api/wt/v1/rum/events?k=wtp_abc&x=1', {
    method: 'POST', body: 'hi', headers: { cookie: 'sid=1', authorization: 'Bearer secret-user-token', 'content-type': 'application/json' },
  }));
  expect(ok.status).toBe(200);
  expect(seen[0]).toEqual({ url: 'http://edge/v1/rum/events?k=wtp_abc', headers: { 'content-type': 'application/json' } });
  expect((await POST(new Request('http://app/api/wt/v1/projects/p/issues', { method: 'POST', body: 'x' }))).status).toBe(404);
  expect((await POST(new Request('http://app/api/wt/v1/rum/events', { method: 'POST', body: 'x'.repeat(11) }))).status).toBe(413);
  expect(seen.length).toBe(1);
});
