// Auto-instrumentation: node:http, fetch (undici), pg and ioredis, each only when its optional peer package is installed.
import { load } from './load.js';

interface Providers { tracerProvider: unknown; meterProvider?: unknown }

const ENTRIES: { pkg: string; ctor: string; opts: (self: URL[]) => object }[] = [
  {
    pkg: '@opentelemetry/instrumentation-http', ctor: 'HttpInstrumentation',
    // our own exports and API calls must not become spans
    opts: (self) => ({ ignoreOutgoingRequestHook: (r: { hostname?: string; host?: string; port?: string | number }) =>
      self.some((u) => (r.hostname || r.host) === u.hostname && String(r.port ?? (u.protocol === 'https:' ? 443 : 80)) === String(u.port || (u.protocol === 'https:' ? 443 : 80))) }),
  },
  {
    pkg: '@opentelemetry/instrumentation-undici', ctor: 'UndiciInstrumentation',
    opts: (self) => ({ ignoreRequestHook: (r: { origin?: string }) => self.some((u) => r.origin === u.origin) }),
  },
  { pkg: '@opentelemetry/instrumentation-pg', ctor: 'PgInstrumentation', opts: () => ({}) },
  { pkg: '@opentelemetry/instrumentation-ioredis', ctor: 'IORedisInstrumentation', opts: () => ({}) },
];

/** Register whichever of the four instrumentations is installed. Returns the package names that were enabled. */
export function instrumentAll(p: Providers, selfUrls: string[]): string[] {
  let registerInstrumentations: (o: object) => () => void;
  try {
    ({ registerInstrumentations } = load('@opentelemetry/instrumentation') as { registerInstrumentations: typeof registerInstrumentations });
  } catch {
    return []; // optional peer not installed
  }
  const self = selfUrls.flatMap((u) => { try { return [new URL(u)]; } catch { return []; } });
  const found: object[] = [];
  const names: string[] = [];
  for (const e of ENTRIES) {
    try {
      const Ctor = (load(e.pkg) as Record<string, new (o: object) => object>)[e.ctor];
      if (Ctor) { found.push(new Ctor(e.opts(self))); names.push(e.pkg); }
    } catch {
      // package not installed (or failed to construct): skip it, never break init
    }
  }
  if (found.length) registerInstrumentations({ instrumentations: found, tracerProvider: p.tracerProvider, meterProvider: p.meterProvider });
  return names;
}
