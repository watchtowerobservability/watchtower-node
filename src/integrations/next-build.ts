// Build-time helpers for Next.js: `withWatchtower` (next.config) and `uploadSourcemaps` (after `next build`).
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import * as zlib from 'node:zlib';
import { injectDebugIds } from './next-debugid.js';

export interface SourcemapOptions {
  /** Directory holding the client build; default `.next/static`. */
  dir?: string;
  /** Default WT_API_URL (old name WT_API still works, with a warning), then https://watchtowerops.net. */
  apiUrl?: string;
  /** A key with scope `ci:write` (it covers releases and artifacts; `admin:write` also works). Default WT_API_KEY. */
  apiKey?: string;
  /** Project id or slug the maps belong to. Default WT_PROJECT. */
  project?: string;
  /** Release version: must equal the `release` the browser SDK reports. Default WT_RELEASE. */
  release?: string;
  /** Keep the .map files after a successful upload (default: delete them so they are never served). */
  keep?: boolean;
  /** Before uploading, write a debug id into each chunk (`//# debugId=` plus a runtime registration) and its map (`debugId`), so errors resolve by id instead of release + file name. Default false (`--inject` on the CLI). */
  inject?: boolean;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

type NextConfig = Record<string, unknown>;
type ConfigOrFn = NextConfig | ((...a: unknown[]) => NextConfig | Promise<NextConfig>);

export interface WatchtowerNextOptions {
  /**
   * `true` turns on `productionBrowserSourceMaps`. `{ upload: true }` also uploads `.next/static/**\/*.map` when the
   * webpack client build finishes (CI: needs WT_API_KEY, WT_PROJECT; the release is `release` below) and, unless
   * `deleteAfterUpload: false`, deletes the maps. Turbopack has no webpack hooks: run `wt-next-sourcemaps` after `next build`.
   * Other fields are `uploadSourcemaps` options (`apiUrl`, `project`, `inject`, `fetch`, ...).
   */
  sourcemaps?: boolean | (Omit<SourcemapOptions, 'keep' | 'release'> & { upload?: boolean; deleteAfterUpload?: boolean });
  /** Release: injected as `NEXT_PUBLIC_WT_RELEASE` (read by `<WatchtowerRUM>`). Default WT_RELEASE, then the git sha of the CI/host env. */
  release?: string;
}

// what the node SDK loads at run time through createRequire (invisible to Next's file tracer): see src/load.ts
const OTEL = [
  '@opentelemetry/api', '@opentelemetry/context-async-hooks', '@opentelemetry/core', '@opentelemetry/exporter-logs-otlp-http',
  '@opentelemetry/exporter-metrics-otlp-http', '@opentelemetry/exporter-trace-otlp-http', '@opentelemetry/instrumentation',
  '@opentelemetry/otlp-transformer', '@opentelemetry/resources', '@opentelemetry/sdk-logs', '@opentelemetry/sdk-metrics',
  '@opentelemetry/sdk-trace',
];
const EXTERNAL = ['@watchtowerobservability/node', ...OTEL];
const SHA_ENV = ['WT_RELEASE', 'GITHUB_SHA', 'CI_COMMIT_SHA', 'VERCEL_GIT_COMMIT_SHA', 'SOURCE_VERSION', 'BUILD_SHA', 'RENDER_GIT_COMMIT', 'HEROKU_SLUG_COMMIT'];
const INCLUDE = ['@watchtowerobservability/node', '@opentelemetry'].flatMap((p) => [`./node_modules/${p}/**/*`, `./node_modules/.pnpm/${p.replace('/', '+')}*/**/*`]);

/**
 * `module.exports = withWatchtower(nextConfig, { sourcemaps: true })`. Makes `output: 'standalone'` work with no other
 * config: the node SDK and its OpenTelemetry peers go into `serverExternalPackages` and (npm and pnpm layouts) into
 * `outputFileTracingIncludes` for every route. Sets `NEXT_PUBLIC_WT_RELEASE`. With `sourcemaps` it turns on
 * `productionBrowserSourceMaps` (webpack and Turbopack); `{ upload: true }` uploads and deletes them after the webpack
 * client build, otherwise run `wt-next-sourcemaps` after `next build` (`"build": "next build && wt-next-sourcemaps"`).
 */
export function withWatchtower(config: ConfigOrFn = {}, opts: WatchtowerNextOptions = {}): ConfigOrFn {
  const sm = opts.sourcemaps === true ? {} : opts.sourcemaps || undefined;
  const release = opts.release || SHA_ENV.map((k) => process.env[k]).find((v) => v && v !== 'unknown');
  const apply = (c: NextConfig): NextConfig => {
    const inc = { ...(c.outputFileTracingIncludes as Record<string, string[]> | undefined) };
    inc['/*'] = [...new Set([...(inc['/*'] ?? []), ...INCLUDE])];
    const out: NextConfig = {
      ...c,
      serverExternalPackages: [...new Set([...((c.serverExternalPackages as string[] | undefined) ?? []), ...EXTERNAL])],
      outputFileTracingIncludes: inc,
    };
    if (release) out.env = { NEXT_PUBLIC_WT_RELEASE: release, ...(c.env as Record<string, string> | undefined) };
    if (sm) out.productionBrowserSourceMaps = true;
    if (sm && 'upload' in sm && sm.upload) {
      const { upload: _u, deleteAfterUpload, ...so } = sm;
      const w = c.webpack as ((cfg: { plugins?: unknown[] }, ctx: { dev?: boolean; isServer?: boolean }) => unknown) | undefined;
      out.webpack = (cfg: { plugins?: unknown[] }, ctx: { dev?: boolean; isServer?: boolean }) => {
        const r = (w ? w(cfg, ctx) : cfg) as { plugins?: unknown[] };
        if (!ctx.dev && !ctx.isServer) {
          (r.plugins ??= []).push({
            apply(compiler: { hooks: { done: { tapPromise(n: string, f: () => Promise<void>): void } } }) {
              compiler.hooks.done.tapPromise('watchtower-sourcemaps', async () => {
                try {
                  await uploadSourcemaps({ log: (l) => console.log(`[watchtower] ${l}`), ...so, release, keep: deleteAfterUpload === false });
                } catch (e) {
                  console.warn(`[watchtower] source map upload skipped: ${(e as Error).message}`);
                }
              });
            },
          });
        }
        return r;
      };
    }
    return out;
  };
  if (typeof config !== 'function') return apply(config);
  return async (...a: unknown[]) => apply(await config(...a));
}

function* maps(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = nodePath.join(dir, e.name);
    if (e.isDirectory()) yield* maps(p);
    else if (e.name.endsWith('.map')) yield p;
  }
}

/** A ustar archive of `[name, bytes]` (names up to 100 bytes). */
export function makeTar(files: [string, Buffer][]): Buffer {
  const parts: Buffer[] = [];
  for (const [name, data] of files) {
    const h = Buffer.alloc(512);
    h.write(name, 0, 100, 'utf8');
    h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148); h.write('0', 156); h.write('ustar\0', 257); h.write('00', 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    parts.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The client chunk (`_next/static/...`) a map belongs to: the sibling JS's `//# sourceMappingURL=` target, else the map's own `file` field. */
function chunkFor(mapFile: string, name: string): string | undefined {
  try {
    const js = mapFile.slice(0, -'.map'.length);
    if (fs.existsSync(js)) {
      const tail = fs.readFileSync(js, 'utf8').slice(-512);
      if (/\/\/[#@] sourceMappingURL=/.test(tail)) return name.slice(0, -'.map'.length);
    }
    const file = (JSON.parse(fs.readFileSync(mapFile, 'utf8')) as { file?: unknown }).file;
    if (typeof file === 'string' && file) return `${nodePath.posix.dirname(name)}/${nodePath.posix.basename(file)}`;
  } catch { /* unreadable: upload without `for` */ }
  return undefined;
}

/**
 * Upload every `.map` under `dir` as `_next/static/<path>` for the release: one `POST /artifacts/bundle` per ~120 MB
 * batch (tar.gz plus manifest), falling back to single uploads (8 at a time) when the server has no bundle route.
 * 429/5xx are retried with backoff honoring Retry-After; a failed map does not stop the others. The maps are deleted when none failed. Returns
 * `{uploaded, skipped, failed}`: `skipped` = the server already had those exact bytes (HTTP 200). Bodies are sent
 * gzipped (`Content-Encoding: gzip`).
 */
export async function uploadSourcemaps(o: SourcemapOptions = {}): Promise<{ uploaded: number; skipped: number; failed: number }> {
  const env = process.env;
  const key = o.apiKey || env.WT_API_KEY;
  const project = o.project || env.WT_PROJECT;
  const release = o.release || env.WT_RELEASE;
  if (!key) throw new Error('WT_API_KEY is required (a key with scope ci:write)');
  if (!project) throw new Error('WT_PROJECT (project id) is required');
  if (!release) throw new Error('WT_RELEASE is required');
  const log = o.log || (() => {});
  if (!o.apiUrl && !env.WT_API_URL && env.WT_API) log('WT_API is deprecated, use WT_API_URL');
  const base = (o.apiUrl || env.WT_API_URL || env.WT_API || 'https://watchtowerops.net').replace(/\/+$/, '');
  const dir = nodePath.resolve(o.dir || '.next/static');
  const f = o.fetch || fetch;
  const root = `${base}/v1/projects/${encodeURIComponent(project)}`;
  const send = async (path: string, init: RequestInit, retries: number): Promise<Response> => {
    for (let attempt = 0; ; attempt++) {
      let res: Response | undefined;
      try {
        res = await f(root + path, { ...init, headers: { authorization: `Bearer ${key}`, ...(init.headers as Record<string, string>) } });
      } catch (e) {
        const cause = (e as { cause?: { code?: string; message?: string } }).cause;
        throw new Error(`cannot reach ${base} (${cause?.code || cause?.message || (e as Error).message}); check WT_API_URL`);
      }
      if ((res.status !== 429 && res.status < 500) || attempt >= retries) return res;
      const ra = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 30) * 1000 : Math.min(250 * 2 ** attempt, 8000));
    }
  };
  const ids = o.inject && fs.existsSync(dir) ? injectDebugIds(dir) : new Map<string, string>();
  if (o.inject) log(`debug ids written for ${ids.size} chunks`);
  const files = fs.existsSync(dir) ? [...maps(dir)] : [];
  // release create fails fast: no retry, so a bad host or key surfaces at once
  const rel = await send('/releases', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: release }) }, 0);
  if (!rel.ok && rel.status !== 409) throw new Error(`watchtower POST /releases -> HTTP ${rel.status}${rel.status === 401 || rel.status === 403 ? ' (check WT_API_KEY scope ci:write)' : ''}`);
  let uploaded = 0, skipped = 0, failed = 0;
  const entries = files.map((file) => {
    const name = `_next/static/${nodePath.relative(dir, file).split(nodePath.sep).join('/')}`;
    return { file, name, chunk: chunkFor(file, name), id: ids.get(file) };
  });
  type Entry = (typeof entries)[number];
  const single = async (e: Entry): Promise<void> => {
    const q: Record<string, string> = { kind: 'sourcemap', name: e.name, release };
    if (e.chunk) q.for = e.chunk;
    if (e.id) q.debug_id = e.id;
    try {
      const res = await send(`/artifacts?${new URLSearchParams(q)}`, {
        method: 'POST', headers: { 'content-type': 'application/octet-stream', 'content-encoding': 'gzip' },
        body: new Uint8Array(zlib.gzipSync(fs.readFileSync(e.file))),
      }, 4);
      if (res.status === 200) skipped++;
      else if (res.ok) uploaded++;
      else { failed++; log(`failed ${e.name}: HTTP ${res.status}`); }
    } catch (err) {
      failed++;
      log(`failed ${e.name}: ${(err as Error).message}`);
    }
  };
  const concurrently = async (list: Entry[]): Promise<void> => {
    let next = 0;
    const worker = async (): Promise<void> => {
      for (let e = list[next++]; e !== undefined; e = list[next++]) await single(e);
    };
    await Promise.all(Array.from({ length: Math.min(8, list.length) }, worker));
  };
  // One request per batch (tar.gz + manifest). A server without the bundle route (or a request that
  // never got through) falls back to concurrent single uploads for that batch.
  const BATCH_BYTES = 120 * 1024 * 1024;
  const batches: Entry[][] = [];
  let cur: Entry[] = [], curBytes = 0;
  for (const e of entries) {
    const size = fs.statSync(e.file).size;
    if (cur.length && curBytes + size > BATCH_BYTES) { batches.push(cur); cur = []; curBytes = 0; }
    cur.push(e); curBytes += size;
  }
  if (cur.length) batches.push(cur);
  for (const batch of batches) {
    let handled = false;
    try {
      const manifest = { files: batch.map((e, i) => ({ path: `m${i}.map`, name: e.name, ...(e.chunk ? { for: e.chunk } : {}), ...(e.id ? { debug_id: e.id } : {}) })) };
      const tar = makeTar([['manifest.json', Buffer.from(JSON.stringify(manifest))], ...batch.map((e, i): [string, Buffer] => [`m${i}.map`, fs.readFileSync(e.file)])]);
      const res = await send(`/artifacts/bundle?${new URLSearchParams({ release })}`, {
        method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array(zlib.gzipSync(tar)),
      }, 4);
      const r = res.ok ? ((await res.json().catch(() => ({}))) as { uploaded?: number; skipped?: number; failed?: number; errors?: { name: string; reason: string }[] }) : {};
      if (typeof r.uploaded === 'number') { // anything else is not our bundle route: fall back
        uploaded += r.uploaded; skipped += r.skipped || 0; failed += r.failed || 0;
        for (const e of r.errors || []) log(`failed ${e.name}: ${e.reason}`);
        handled = true;
      } else if (res.status === 401 || res.status === 403) {
        throw new Error(`watchtower POST /artifacts/bundle -> HTTP ${res.status} (check WT_API_KEY scope ci:write)`);
      }
    } catch (e) {
      if ((e as Error).message.startsWith('watchtower ') || (e as Error).message.startsWith('cannot reach')) throw e;
    }
    if (!handled) await concurrently(batch);
  }
  if (!o.keep && failed === 0) for (const file of files) fs.rmSync(file);
  log(`${JSON.stringify({ uploaded, skipped, failed })} source maps for release ${release}${o.keep || failed ? '' : '; deleted the .map files'}`);
  return { uploaded, skipped, failed };
}
