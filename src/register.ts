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
      // Node 26 prints DEP0205 for module.register(); import-in-the-middle's hook has no sync (registerHooks) form yet,
      // so mute only that one warning for this call.
      const emit = process.emitWarning;
      process.emitWarning = ((w: unknown, ...a: unknown[]) => {
        if (JSON.stringify(a).includes('DEP0205')) return;
        return (emit as (...x: unknown[]) => void).call(process, w, ...a);
      }) as typeof process.emitWarning;
      try {
        registerHooks('@opentelemetry/instrumentation/hook.mjs', pathToFileURL(`${process.cwd()}/`));
      } catch {
        // @opentelemetry/instrumentation not installed: CommonJS apps are still instrumented
      } finally {
        process.emitWarning = emit;
      }
    }
    init({});
  } catch (e) {
    console.warn(`[watchtower] register: ${(e as Error).message}`);
  }
}
