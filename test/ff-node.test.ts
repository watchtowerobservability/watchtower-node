import { test, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { context, trace } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace';
import * as wt from '../src/index.js';
import { VERSION } from '../src/version.js';
import { startDbSpan } from '../src/integrations/db.js';
import { checkin } from '../src/checkin.js';
import { installSignalFlush } from '../src/shutdown.js';
import { isNextInternal, nextInternalsFilter } from '../src/integrations/next.js';
import { tunnelHandler } from '../src/integrations/next-tunnel.js';
import { tracingIncludes, uploadSourcemaps, withWatchtower } from '../src/integrations/next-build.js';

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

test('requireParent: no span without an active parent (HTTP active / WATCHTOWER_DB_REQUIRE_PARENT=1), one with it, always with requireParent:false', () => {
  const op = { system: 'sqlite', sql: 'SELECT 1' };
  process.env.WATCHTOWER_DB_REQUIRE_PARENT = '1';
  expect(startDbSpan(op, undefined, context.active()).isRecording()).toBe(false);
  expect(startDbSpan(op, { requireParent: false }, context.active()).isRecording()).toBe(true);
  trace.getTracer('t').startActiveSpan('request', (parent) => {
    const s = startDbSpan(op, undefined, context.active());
    expect(s.isRecording()).toBe(true);
    s.end();
    parent.end();
  });
  delete process.env.WATCHTOWER_DB_REQUIRE_PARENT;
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
  expect(withWatchtower({ a: 1 }, { sourcemaps: true, release: 'r1' })).toMatchObject({ a: 1, productionBrowserSourceMaps: true });
  expect(withWatchtower({ a: 1 }, { release: 'r1' })).not.toHaveProperty('productionBrowserSourceMaps');
  const fn = withWatchtower(() => ({ b: 2 }), { sourcemaps: true, release: 'r1' }) as () => Promise<unknown>;
  expect(await fn()).toMatchObject({ b: 2, productionBrowserSourceMaps: true });
});

test('withWatchtower: standalone zero config (externals, tracing includes, release), user values kept', () => {
  const c = withWatchtower({ serverExternalPackages: ['sharp'], outputFileTracingIncludes: { '/x': ['a'], '/*': ['b'] }, env: { NEXT_PUBLIC_WT_RELEASE: 'mine' } }, { release: 'r1' }) as Record<string, any>;
  expect(c.serverExternalPackages).toEqual(expect.arrayContaining(['sharp', '@watchtowerobservability/node', '@opentelemetry/sdk-trace', '@opentelemetry/exporter-trace-otlp-http']));
  expect(c.outputFileTracingIncludes['/x']).toEqual(['a']);
  expect(c.outputFileTracingIncludes['/*'][0]).toBe('b');
  expect(c.outputFileTracingIncludes['/*'].some((g: string) => g.includes('node_modules/@opentelemetry/**'))).toBe(false); // broke pnpm (B22)
  expect(c.env.NEXT_PUBLIC_WT_RELEASE).toBe('mine');
  expect((withWatchtower({}, { release: 'r1' }) as Record<string, any>).env).toEqual({ NEXT_PUBLIC_WT_RELEASE: 'r1' });
});

test('withWatchtower sourcemaps.upload: client webpack build uploads and deletes the maps, server build does not', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-next-'));
  fs.writeFileSync(path.join(dir, 'a.js.map'), '{"version":3}');
  const f = (async (u: string) => new Response('{}', { status: u.includes('/releases') ? 409 : 201 })) as unknown as typeof fetch;
  const c = withWatchtower({}, { release: 'r1', sourcemaps: { upload: true, deleteAfterUpload: true, dir, apiKey: 'k', project: 'p', apiUrl: 'http://api', fetch: f } }) as { webpack: (cfg: any, ctx: any) => any };
  expect(c.webpack({}, { isServer: true }).plugins).toBeUndefined();
  expect(c.webpack({}, { dev: true }).plugins).toBeUndefined();
  const plugins = c.webpack({}, { isServer: false }).plugins as { apply: (x: unknown) => void }[];
  let done: (() => Promise<void>) | undefined;
  plugins[0]!.apply({ hooks: { done: { tapPromise: (_n: string, fn: () => Promise<void>) => { done = fn; } } } });
  await done!();
  expect(fs.existsSync(path.join(dir, 'a.js.map'))).toBe(false);
});

test('uploadSourcemaps uploads each map under _next/static, then deletes them', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-next-'));
  fs.mkdirSync(path.join(dir, 'chunks'));
  fs.writeFileSync(path.join(dir, 'chunks', 'a.js.map'), '{"version":3}');
  fs.writeFileSync(path.join(dir, 'chunks', 'a.js'), 'x');
  const urls: string[] = [];
  const f = (async (u: string, init: RequestInit) => { urls.push(`${init.method} ${u} ${(init.headers as Record<string, string>).authorization}`); return new Response('{}', { status: 201 }); }) as unknown as typeof fetch;
  const r = await uploadSourcemaps({ dir, apiKey: 'k', project: 'p1', release: 'r1', apiUrl: 'http://api', fetch: f });
  expect(r).toEqual({ uploaded: 1, skipped: 0, failed: 0 });
  expect(urls[0]).toBe('POST http://api/v1/projects/p1/releases Bearer k');
  expect(urls[1]).toBe('POST http://api/v1/projects/p1/artifacts/bundle?release=r1 Bearer k');
  expect(urls[2]).toBe('POST http://api/v1/projects/p1/artifacts?kind=sourcemap&name=_next%2Fstatic%2Fchunks%2Fa.js.map&release=r1 Bearer k');
  expect(fs.existsSync(path.join(dir, 'chunks', 'a.js.map'))).toBe(false);
  expect(fs.existsSync(path.join(dir, 'chunks', 'a.js'))).toBe(true);
});

test('uploadSourcemaps sends one tar.gz bundle request and reports the server counts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-next-'));
  for (const n of ['a', 'b']) fs.writeFileSync(path.join(dir, `${n}.js.map`), '{"version":3}');
  const calls: { url: string; body?: Buffer }[] = [];
  const f = (async (u: string, init: RequestInit) => {
    calls.push({ url: u, body: init.body ? Buffer.from(init.body as Uint8Array) : undefined });
    if (u.endsWith('/releases')) return new Response('{}', { status: 201 });
    return new Response(JSON.stringify({ uploaded: 1, skipped: 1, failed: 0, errors: [] }), { status: 200 });
  }) as unknown as typeof fetch;
  const r = await uploadSourcemaps({ dir, apiKey: 'k', project: 'p', release: 'r', apiUrl: 'http://api', fetch: f });
  expect(r).toEqual({ uploaded: 1, skipped: 1, failed: 0 });
  expect(calls.map((c) => c.url)).toEqual(['http://api/v1/projects/p/releases', 'http://api/v1/projects/p/artifacts/bundle?release=r']);
  const tar = zlib.gunzipSync(calls[1]!.body!);
  expect(tar.subarray(0, 13).toString()).toBe('manifest.json');
  expect(tar.toString('latin1')).toContain('"name":"_next/static/a.js.map"');
  expect(fs.existsSync(path.join(dir, 'a.js.map'))).toBe(false);
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

test('nextInternals samples a root (parentless) INTERNAL span', () => {
  const root = nextSpan('load route module', 'LoadComponents.loadRouteModule', { parentSpanContext: undefined } as never);
  expect(isNextInternal(root)).toBe(true);
  expect(nextInternalsFilter('sample', 0.1, () => 0.5)(root)).toBe(false);
  expect(nextInternalsFilter('sample', 0.1, () => 0.05)(root)).toBe(true);
});

test('tunnel forwards Origin and Referer (edge origin check), Referer origin for same-origin GETs', async () => {
  const seen: Record<string, string>[] = [];
  const f = (async (_u: string, init: RequestInit) => { seen.push(init.headers as Record<string, string>); return new Response('{}'); }) as unknown as typeof fetch;
  const { POST, GET } = tunnelHandler({ endpoint: 'http://edge', fetch: f });
  await POST(new Request('http://app/api/wt/v1/rum/events?k=wtp_a', { method: 'POST', body: 'x', headers: { origin: 'https://site.example', referer: 'https://site.example/p?q=1' } }));
  expect(seen[0]).toMatchObject({ origin: 'https://site.example', referer: 'https://site.example/p?q=1' });
  await GET(new Request('http://app/api/wt/v1/rum/config?k=wtp_a', { headers: { referer: 'https://site.example/p' } }));
  expect(seen[1]!.origin).toBe('https://site.example');
});

test('tunnel allowKey: only beacons with a matching key (query or bearer) are forwarded', async () => {
  let n = 0;
  const f = (async () => { n++; return new Response('{}'); }) as unknown as typeof fetch;
  const { POST } = tunnelHandler({ endpoint: 'http://edge', allowKey: ['wtp_mine'], fetch: f });
  const post = (q: string, h: Record<string, string> = {}) => POST(new Request(`http://app/api/wt/v1/rum/events${q}`, { method: 'POST', body: 'x', headers: h }));
  expect((await post('?k=wtp_other')).status).toBe(403);
  expect((await post('')).status).toBe(403);
  expect((await post('?k=wtp_mine')).status).toBe(200);
  expect((await post('', { authorization: 'Bearer wtp_mine' })).status).toBe(200);
  expect(n).toBe(2);
});

test('tunnel allows /v1/traces', async () => {
  const seen: string[] = [];
  const f = (async (url: string) => { seen.push(url); return new Response('{}'); }) as unknown as typeof fetch;
  const { POST } = tunnelHandler({ endpoint: 'http://edge', fetch: f });
  expect((await POST(new Request('http://app/api/wt/v1/traces?k=wtp_a', { method: 'POST', body: 'x' }))).status).toBe(200);
  expect(seen).toEqual(['http://edge/v1/traces?k=wtp_a']);
});

test('uploadSourcemaps: retries 429, continues past a failure, sends for=, exits counts, keeps files on failure', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-next-'));
  for (const n of ['a', 'b']) {
    fs.writeFileSync(path.join(dir, `${n}.js.map`), '{"version":3}');
    fs.writeFileSync(path.join(dir, `${n}.js`), `x\n//# sourceMappingURL=${n}.js.map`);
  }
  const hits: string[] = [];
  let aTries = 0;
  const f = (async (u: string) => {
    hits.push(u);
    if (u.includes('name=_next%2Fstatic%2Fb.js.map')) return new Response('', { status: 400 });
    if (u.includes('a.js.map') && aTries++ === 0) return new Response('', { status: 429, headers: { 'retry-after': '0' } });
    return new Response('{}', { status: u.includes('/releases') ? 409 : 201 });
  }) as unknown as typeof fetch;
  const r = await uploadSourcemaps({ dir, apiKey: 'k', project: 'p', release: 'r', apiUrl: 'http://api', fetch: f });
  expect(r).toEqual({ uploaded: 1, skipped: 0, failed: 1 });
  expect(aTries).toBe(2);
  expect(hits.some((u) => u.includes('for=_next%2Fstatic%2Fa.js'))).toBe(true);
  expect(fs.existsSync(path.join(dir, 'a.js.map'))).toBe(true);
});

test('uploadSourcemaps: unreachable host fails fast with a clear message', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-next-'));
  const f = (async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); }) as unknown as typeof fetch;
  await expect(uploadSourcemaps({ dir, apiKey: 'k', project: 'p', release: 'r', apiUrl: 'http://nope.invalid', fetch: f }))
    .rejects.toThrow(/cannot reach http:\/\/nope.invalid \(ENOTFOUND\)/);
});

test('uploadSourcemaps inject: writes debug ids into chunk and map, sends debug_id, is stable on rerun', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-next-'));
  fs.mkdirSync(path.join(dir, 'chunks'));
  const js = path.join(dir, 'chunks', 'a.js');
  fs.writeFileSync(js, 'console.log(1)\n//# sourceMappingURL=a.js.map\n');
  fs.writeFileSync(`${js}.map`, '{"version":3,"file":"a.js","sources":[],"mappings":""}');
  fs.writeFileSync(path.join(dir, 'chunks', 'nomap.js'), 'x');
  const urls: string[] = [];
  const f = (async (u: string) => { urls.push(u); return new Response('{}', { status: 201 }); }) as unknown as typeof fetch;
  const run = () => uploadSourcemaps({ dir, apiKey: 'k', project: 'p', release: 'r', apiUrl: 'http://api', fetch: f, keep: true, inject: true });
  expect(await run()).toEqual({ uploaded: 1, skipped: 0, failed: 0 });
  const id = /\/\/# debugId=(\S+)\n$/.exec(fs.readFileSync(js, 'utf8'))![1]!;
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(fs.readFileSync(js, 'utf8')).toContain(`["/_next/static/chunks/a.js"]="${id}"`);
  expect(fs.readFileSync(js, 'utf8').indexOf('sourceMappingURL')).toBeLessThan(fs.readFileSync(js, 'utf8').indexOf('//# debugId'));
  expect(JSON.parse(fs.readFileSync(`${js}.map`, 'utf8')).debugId).toBe(id);
  expect(fs.readFileSync(path.join(dir, 'chunks', 'nomap.js'), 'utf8')).toBe('x');
  expect(new URL(urls.find((u) => u.includes('/artifacts?'))!).searchParams.get('debug_id')).toBe(id);
  const before = fs.readFileSync(js, 'utf8');
  await run();
  expect(fs.readFileSync(js, 'utf8')).toBe(before);
});

test('withWatchtower keeps every @opentelemetry package the SDK loads external (B9b)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
  const otel = [...new Set(['dependencies', 'peerDependencies', 'optionalDependencies'].flatMap((k) => Object.keys(pkg[k] ?? {})))].filter((n) => n.startsWith('@opentelemetry/'));
  const ext = (withWatchtower({}) as { serverExternalPackages: string[] }).serverExternalPackages;
  expect(otel.filter((n) => !ext.includes(n))).toEqual([]);
});

test('withWatchtower next to Sentry keeps the OTel packages Sentry shares bundled (B9b)', async () => {
  const { externalPackages, hasSentry } = await import('../src/integrations/next-build.js');
  expect(externalPackages(false)).toContain('@opentelemetry/api');
  const s = externalPackages(true);
  expect(s).not.toContain('@opentelemetry/api');
  expect(s).not.toContain('@opentelemetry/instrumentation');
  expect(s).toContain('@opentelemetry/instrumentation-http');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-sentry-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { '@sentry/nextjs': '^9' } }));
  expect(hasSentry(dir)).toBe(true);
  expect(hasSentry(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-nosentry-')))).toBe(false);
  expect((withWatchtower({}, { sentry: true }) as { serverExternalPackages: string[] }).serverExternalPackages).not.toContain('@opentelemetry/api');
});

test('withWatchtower: pnpm includes keep links and real folders, and follow dependencies (B22)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-pnpm-'));
  const store = (n: string, deps: Record<string, string> = {}) => {
    const d = path.join(root, 'node_modules', '.pnpm', `${n.replace('/', '+')}@1.0.0`, 'node_modules', n);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: n, dependencies: deps }));
    return d;
  };
  const core = store('@opentelemetry/core', { '@opentelemetry/semantic-conventions': '1' });
  const sem = store('@opentelemetry/semantic-conventions');
  fs.symlinkSync(sem, path.join(path.dirname(core), 'semantic-conventions')); // pnpm puts deps beside the package
  const app = path.join(root, 'apps', 'web');
  fs.mkdirSync(path.join(app, 'node_modules', '@opentelemetry'), { recursive: true });
  fs.symlinkSync(core, path.join(app, 'node_modules', '@opentelemetry', 'core'));
  const inc = tracingIncludes(['@opentelemetry/core', '@opentelemetry/not-installed'], fs.realpathSync(app));
  expect(inc).toEqual([
    'node_modules/@opentelemetry/core',
    '../../node_modules/.pnpm/@opentelemetry+core@1.0.0/node_modules/@opentelemetry/core/**/*',
    '../../node_modules/.pnpm/@opentelemetry+core@1.0.0/node_modules/@opentelemetry/semantic-conventions',
    '../../node_modules/.pnpm/@opentelemetry+semantic-conventions@1.0.0/node_modules/@opentelemetry/semantic-conventions/**/*',
  ]);
});
