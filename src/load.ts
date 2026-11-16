// Optional-peer loader (same source for the CommonJS and ESM builds).
import { createRequire } from 'node:module';
import nodePath from 'node:path';

// Bundlers must NOT follow this: an optional peer the app did not install would make webpack warn "Module not found",
// and a bare require call on a variable id is a "Critical dependency" warning. createRequire() is opaque to webpack/esbuild/Next's tracer,
// so peers resolve at run time from the SDK's own location, then from the app root (cwd). Install the peers in the app
// (pnpm: as direct dependencies). A Next standalone build gets them through withWatchtower's tracingIncludes (next-build.ts).
/** Where peers are searched, in order: the SDK's own location, the cwd, the entry script's directory (pnpm monorepo apps run from the repo root). */
export function searchPaths(): string[] {
  const entry = process.argv[1] ? `${nodePath.dirname(nodePath.resolve(process.argv[1]))}/` : '';
  return [typeof __filename === 'string' ? __filename : '', `${process.cwd()}/`, entry].filter(Boolean);
}
function resolvers(): NodeRequire[] {
  return searchPaths().map((f) => createRequire(f));
}

export function load(id: string): unknown {
  let err: unknown;
  for (const r of resolvers()) {
    try {
      return r(id);
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'MODULE_NOT_FOUND') throw e;
      err ??= e;
    }
  }
  throw err;
}

export const SDK_PEERS = [
  '@opentelemetry/context-async-hooks', '@opentelemetry/core', '@opentelemetry/exporter-logs-otlp-http',
  '@opentelemetry/exporter-metrics-otlp-http', '@opentelemetry/exporter-trace-otlp-http', '@opentelemetry/otlp-transformer',
  '@opentelemetry/resources', '@opentelemetry/sdk-logs', '@opentelemetry/sdk-metrics', '@opentelemetry/sdk-trace',
];

/** Load an OpenTelemetry SDK package (a dependency, loaded lazily); a missing one throws an error naming what to install. */
export function need<T>(id: string): T {
  try {
    return load(id) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'MODULE_NOT_FOUND' && String((e as Error).message).includes(id)) {
      throw new Error(`@watchtowerobservability/node needs the OpenTelemetry SDK, which is not installed (missing ${id}). Run: npm install ${SDK_PEERS.join(' ')}`);
    }
    throw e;
  }
}

export const STANDALONE_HINT = 'use withWatchtower() from @watchtowerobservability/next (node SDK 0.7.9 or later) in next.config';

/** Required OpenTelemetry peers that cannot be loaded from the SDK's location or the app root. */
export function missingPeers(): string[] {
  return SDK_PEERS.filter((id) => {
    try { load(id); return false; } catch { return true; }
  });
}

/**
 * Never called. Literal names so file tracers (Next's standalone nft) copy the SDK packages together with their pnpm
 * links, which outputFileTracingIncludes cannot do. Safe for bundlers: these are dependencies, so always installed.
 */
export const tracedPackages = (): Promise<unknown>[] => [
  import('@opentelemetry/context-async-hooks'), import('@opentelemetry/core'), import('@opentelemetry/exporter-logs-otlp-http'),
  import('@opentelemetry/exporter-metrics-otlp-http'), import('@opentelemetry/exporter-trace-otlp-http'), import('@opentelemetry/otlp-transformer'),
  import('@opentelemetry/resources'), import('@opentelemetry/sdk-logs'), import('@opentelemetry/sdk-metrics'), import('@opentelemetry/sdk-trace'),
];
