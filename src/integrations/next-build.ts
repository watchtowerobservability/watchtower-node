// Build-time helpers for Next.js: `withWatchtower` (next.config) and `uploadSourcemaps` (after `next build`).
import * as fs from 'node:fs';
import * as nodePath from 'node:path';

export interface SourcemapOptions {
  /** Directory holding the client build; default `.next/static`. */
  dir?: string;
  /** Default WT_API_URL, then https://api.watchtower.observer. */
  apiUrl?: string;
  /** A key with scope `ci:write` (it covers releases and artifacts; `admin:write` also works). Default WT_API_KEY. */
  apiKey?: string;
  /** Project id or slug the maps belong to. Default WT_PROJECT. */
  project?: string;
  /** Release version: must equal the `release` the browser SDK reports. Default WT_RELEASE. */
  release?: string;
  /** Keep the .map files after a successful upload (default: delete them so they are never served). */
  keep?: boolean;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

type NextConfig = Record<string, unknown>;
type ConfigOrFn = NextConfig | ((...a: unknown[]) => NextConfig | Promise<NextConfig>);

/**
 * `module.exports = withWatchtower(nextConfig, { sourcemaps: true })`: turns on `productionBrowserSourceMaps` so
 * `next build` writes client maps (works with webpack and Turbopack). Then run `wt-next-sourcemaps` after the build
 * (`"build": "next build && wt-next-sourcemaps"`) to upload them and delete the .map files from `.next/static`.
 */
export function withWatchtower(config: ConfigOrFn = {}, opts: { sourcemaps?: boolean } = {}): ConfigOrFn {
  const apply = (c: NextConfig): NextConfig => (opts.sourcemaps ? { ...c, productionBrowserSourceMaps: true } : c);
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

/** Upload every `.map` under `dir` as `_next/static/<path>` for the release, then delete them. Throws (leaving the files) when an upload fails. */
export async function uploadSourcemaps(o: SourcemapOptions = {}): Promise<{ uploaded: number }> {
  const env = process.env;
  const key = o.apiKey || env.WT_API_KEY;
  const project = o.project || env.WT_PROJECT;
  const release = o.release || env.WT_RELEASE;
  if (!key) throw new Error('WT_API_KEY is required (a key with scope ci:write)');
  if (!project) throw new Error('WT_PROJECT (project id) is required');
  if (!release) throw new Error('WT_RELEASE is required');
  const dir = nodePath.resolve(o.dir || '.next/static');
  const f = o.fetch || fetch;
  const log = o.log || (() => {});
  const root = `${(o.apiUrl || env.WT_API_URL || 'https://api.watchtower.observer').replace(/\/+$/, '')}/v1/projects/${encodeURIComponent(project)}`;
  const call = async (path: string, init: RequestInit, okStatus: number[] = []): Promise<void> => {
    const res = await f(root + path, { ...init, headers: { authorization: `Bearer ${key}`, ...(init.headers as Record<string, string>) } });
    if (!res.ok && !okStatus.includes(res.status)) throw new Error(`watchtower ${init.method} ${path.split('?')[0]} -> HTTP ${res.status}`);
  };
  const files = fs.existsSync(dir) ? [...maps(dir)] : [];
  await call('/releases', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: release }) }, [409]); // 409: exists
  for (const file of files) {
    const name = `_next/static/${nodePath.relative(dir, file).split(nodePath.sep).join('/')}`;
    await call(`/artifacts?${new URLSearchParams({ kind: 'sourcemap', name, release })}`, {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array(fs.readFileSync(file)),
    });
  }
  if (!o.keep) for (const file of files) fs.rmSync(file);
  log(`uploaded ${files.length} source maps for release ${release}${o.keep ? '' : ' and deleted them'}`);
  return { uploaded: files.length };
}
