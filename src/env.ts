import * as fs from 'node:fs';
import * as nodePath from 'node:path';

// Standard OTEL_* environment variables, used as fallbacks after the WT_* ones.

/** Parse `k=v,k2=v2` (OTEL_RESOURCE_ATTRIBUTES / OTEL_EXPORTER_OTLP_HEADERS); values are percent-decoded. */
export function parseKv(s: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (s || '').split(',')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const dec = (x: string): string => { try { return decodeURIComponent(x.trim()); } catch { return x.trim(); } };
    out[dec(part.slice(0, i))] = dec(part.slice(i + 1));
  }
  return out;
}

export interface OtelEnv {
  endpoint?: string;
  /** Header names are lower-cased by nobody: they are kept as written, except `Authorization` is matched case-insensitively. */
  headers: Record<string, string>;
  /** `Authorization: Bearer <key>` from OTEL_EXPORTER_OTLP_HEADERS, the key only. */
  bearer?: string;
  serviceName?: string;
  resource: Record<string, string>;
}

export function otelEnv(env: NodeJS.ProcessEnv = process.env): OtelEnv {
  const headers = parseKv(env.OTEL_EXPORTER_OTLP_HEADERS);
  const authKey = Object.keys(headers).find((k) => k.toLowerCase() === 'authorization');
  const auth = authKey ? headers[authKey]! : undefined;
  if (authKey) delete headers[authKey];
  const resource = parseKv(env.OTEL_RESOURCE_ATTRIBUTES);
  return {
    endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT || undefined,
    headers,
    bearer: auth && /^bearer\s+/i.test(auth) ? auth.replace(/^bearer\s+/i, '') : undefined,
    serviceName: env.OTEL_SERVICE_NAME || resource['service.name'] || undefined,
    resource,
  };
}

const CI_SHA_VARS = ['GITHUB_SHA', 'CI_COMMIT_SHA', 'VERCEL_GIT_COMMIT_SHA', 'SOURCE_VERSION', 'BUILD_SHA', 'RENDER_GIT_COMMIT', 'HEROKU_SLUG_COMMIT'];
const present = (v: string | undefined): string | undefined => { const t = (v || '').trim(); return t && t.toLowerCase() !== 'unknown' ? t : undefined; };
/**
 * The commit `HEAD` points at, found by walking up from `from` to a `.git` directory (a `.git` file of a worktree or submodule is
 * followed through its `gitdir:` line). Reads `HEAD`, then the ref file or `packed-refs`; no child process. undefined when not found.
 */
export function gitHeadSha(from: string): string | undefined {
  const sha = /^[0-9a-f]{40,64}$/i;
  try {
    for (let dir = nodePath.resolve(from); ; dir = nodePath.dirname(dir)) {
      let git = nodePath.join(dir, '.git');
      if (fs.existsSync(git)) {
        if (fs.statSync(git).isFile()) git = nodePath.resolve(dir, /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(git, 'utf8'))?.[1]?.trim() ?? '');
        const head = fs.readFileSync(nodePath.join(git, 'HEAD'), 'utf8').trim();
        if (sha.test(head)) return head; // detached
        const ref = /^ref:\s*(\S+)/.exec(head)?.[1];
        if (!ref) return undefined;
        // a worktree keeps its branch refs in the common dir
        const cd = nodePath.join(git, 'commondir');
        const common = fs.existsSync(cd) ? nodePath.resolve(git, fs.readFileSync(cd, 'utf8').trim()) : git;
        for (const d of [git, common]) {
          try { const v = fs.readFileSync(nodePath.join(d, ref), 'utf8').trim(); if (sha.test(v)) return v; } catch { /* not a loose ref */ }
          try {
            const line = fs.readFileSync(nodePath.join(d, 'packed-refs'), 'utf8').split('\n').find((l) => l.endsWith(` ${ref}`));
            const v = line?.split(' ')[0];
            if (v && sha.test(v)) return v;
          } catch { /* no packed-refs */ }
        }
        return undefined;
      }
      if (nodePath.dirname(dir) === dir) return undefined;
    }
  } catch { return undefined; }
}

/**
 * service.version: explicit option, WT_RELEASE, OTEL_RESOURCE_ATTRIBUTES, the first CI commit-sha variable, the build stamp
 * (`WT_BUILD_STAMP`, `BUILD_STAMP`), then the `.git` HEAD found upward from `gitFrom` (skipped when not given). Empty and `unknown` count as absent.
 */
export function resolveRelease(opt: string | undefined, env: NodeJS.ProcessEnv, otelResource: Record<string, string>, gitFrom?: string): string | undefined {
  for (const v of [opt, env.WT_RELEASE, otelResource['service.version'], ...CI_SHA_VARS.map((k) => env[k]), env.WT_BUILD_STAMP, env.BUILD_STAMP]) { const r = present(v); if (r) return r; }
  return gitFrom ? gitHeadSha(gitFrom) : undefined;
}
