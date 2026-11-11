// Optional-peer loader (same source for the CommonJS and ESM builds).
import { createRequire } from 'node:module';

// Bundlers must NOT follow this: an optional peer the app did not install would make webpack warn "Module not found",
// and a bare require call on a variable id is a "Critical dependency" warning. createRequire() is opaque to webpack/esbuild/Next's tracer,
// so peers resolve at run time from the SDK's own location, then from the app root (cwd). Install the peers in the app
// (pnpm: as direct dependencies); for a Next standalone build add them to outputFileTracingIncludes.
function resolvers(): NodeRequire[] {
  const from = [typeof __filename === 'string' ? __filename : '', `${process.cwd()}/`].filter(Boolean);
  return from.map((f) => createRequire(f));
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

const SDK_PEERS = [
  '@opentelemetry/context-async-hooks', '@opentelemetry/core', '@opentelemetry/exporter-logs-otlp-http',
  '@opentelemetry/exporter-metrics-otlp-http', '@opentelemetry/exporter-trace-otlp-http', '@opentelemetry/otlp-transformer',
  '@opentelemetry/resources', '@opentelemetry/sdk-logs', '@opentelemetry/sdk-metrics', '@opentelemetry/sdk-trace',
];

/** Load an OpenTelemetry SDK package (an optional peer); a missing one throws an error naming what to install. */
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
