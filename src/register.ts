// Preload entry: `node --import @watchtowerobservability/node/register app.mjs` (ESM) or `node -r @watchtowerobservability/node/register app.js` (CommonJS).
// Starts the SDK from WT_*/OTEL_* env before the app loads, so http, fetch, pg and ioredis are patched in time.
// No-op without WT_INGEST_KEY.
import { pathToFileURL } from 'node:url';
import { register as registerHooks } from 'node:module';
import { init } from './index.js';

if (process.env.WT_INGEST_KEY || process.env.OTEL_EXPORTER_OTLP_HEADERS) {
  try {
    // ESM modules (node:http imported from an ES module) are only patched through OpenTelemetry's loader hook
    // (import-in-the-middle). Resolve it from the app, once per process, and skip quietly when it is not installed.
    const g = globalThis as Record<symbol, unknown>;
    const key = Symbol.for('watchtower.node.esm-hook');
    if (!g[key]) {
      g[key] = true;
      try {
        registerHooks('@opentelemetry/instrumentation/hook.mjs', pathToFileURL(`${process.cwd()}/`));
      } catch {
        // @opentelemetry/instrumentation not installed: CommonJS apps are still instrumented
      }
    }
    init({});
  } catch (e) {
    console.warn(`[watchtower] register: ${(e as Error).message}`);
  }
}
