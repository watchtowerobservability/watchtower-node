// Optional-peer loader. Each peer is required by a LITERAL name inside a try block so bundlers (webpack, esbuild, Next's
// file tracer) can follow it; a computed `require(name)` is invisible to them. This is the CommonJS form;
// scripts/build.mjs prepends `const require = createRequire(import.meta.url)` for dist/esm (webpack follows that too).
// The cwd fallback only matters when `require` does not exist (test runners running the TS source as ESM).
import { createRequire } from 'node:module';

const NONE = Symbol('not a known peer');

function known(id: string): unknown {
  try { // bundlers only tolerate an optional require that is lexically inside try
    switch (id) {
      case '@opentelemetry/context-async-hooks': return require('@opentelemetry/context-async-hooks');
      case '@opentelemetry/core': return require('@opentelemetry/core');
      case '@opentelemetry/exporter-logs-otlp-http': return require('@opentelemetry/exporter-logs-otlp-http');
      case '@opentelemetry/exporter-metrics-otlp-http': return require('@opentelemetry/exporter-metrics-otlp-http');
      case '@opentelemetry/exporter-trace-otlp-http': return require('@opentelemetry/exporter-trace-otlp-http');
      case '@opentelemetry/otlp-transformer': return require('@opentelemetry/otlp-transformer');
      case '@opentelemetry/resources': return require('@opentelemetry/resources');
      case '@opentelemetry/sdk-logs': return require('@opentelemetry/sdk-logs');
      case '@opentelemetry/sdk-metrics': return require('@opentelemetry/sdk-metrics');
      case '@opentelemetry/sdk-trace': return require('@opentelemetry/sdk-trace');
      case '@opentelemetry/instrumentation-runtime-node': return require('@opentelemetry/instrumentation-runtime-node');
      case '@opentelemetry/instrumentation': return require('@opentelemetry/instrumentation');
      case '@opentelemetry/instrumentation-http': return require('@opentelemetry/instrumentation-http');
      case '@opentelemetry/instrumentation-undici': return require('@opentelemetry/instrumentation-undici');
      case '@opentelemetry/instrumentation-pg': return require('@opentelemetry/instrumentation-pg');
      case '@opentelemetry/instrumentation-ioredis': return require('@opentelemetry/instrumentation-ioredis');
      case '@opentelemetry/instrumentation-mysql2': return require('@opentelemetry/instrumentation-mysql2');
      case 'winston-transport': return require('winston-transport');
      default: return NONE;
    }
  } catch (e) {
    throw e;
  }
}

export function load(id: string): unknown {
  if (typeof require !== 'function') return createRequire(`${process.cwd()}/`)(id);
  const m = known(id);
  return m === NONE ? require(id) : m;
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
