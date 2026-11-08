// Optional-peer loader (winston-transport). This is the CommonJS form; scripts/build.mjs swaps in an ESM twin
// (createRequire(import.meta.url)) for dist/esm. The cwd fallback only matters when neither exists (test runners).
import { createRequire } from 'node:module';

export function load(id: string): unknown {
  if (typeof require === 'function') return require(id);
  return createRequire(`${process.cwd()}/`)(id);
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
