// Preload entry: `node --import @watchtowerobservability/node/register app.mjs` (ESM) or `node -r @watchtowerobservability/node/register app.js` (CommonJS).
// Starts the SDK from WT_*/OTEL_* env before the app loads, so http, fetch, pg and ioredis are patched in time.
// Without WT_INGEST_KEY it starts nothing and says so.
import { pathToFileURL } from 'node:url';
import { register as registerHooks } from 'node:module';
import { init, setOffReason } from './index.js';
import { searchPaths } from './load.js';

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
        // same search order as the peers: SDK location, cwd, entry script directory; the first that resolves wins
        // (none: @opentelemetry/instrumentation not installed, CommonJS apps are still instrumented)
        for (const p of searchPaths()) {
          try {
            // .ts/.tsx (tsx, ts-node): the hook would re-parse their TypeScript source as JS and fail once per file.
            registerHooks('@opentelemetry/instrumentation/hook.mjs', pathToFileURL(p), { data: { exclude: [/\.[cm]?tsx?(?:[?#]|$)/] } });
            break;
          } catch { /* try the next location */ }
        }
      } finally {
        process.emitWarning = emit;
      }
    }
    init({});
  } catch (e) {
    setOffReason(`the preload could not start the SDK (${(e as Error).message})`);
    console.warn(`[watchtower] telemetry is OFF: register failed: ${(e as Error).message}`);
  }
} else {
  setOffReason('WT_INGEST_KEY is not set');
  if (process.env.NODE_ENV !== 'test') console.warn('[watchtower] telemetry is OFF: WT_INGEST_KEY is not set, so the register preload started nothing');
}
