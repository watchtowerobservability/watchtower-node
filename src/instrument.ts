// Auto-instrumentation: node:http, fetch (undici), pg and ioredis, each only when its optional peer package is installed.
import { load } from './load.js';
import { instrumentBetterSqlite3 } from './integrations/sqlite.js';
import { instrumentPostgres } from './integrations/postgres.js';

interface Providers { tracerProvider: unknown; meterProvider?: unknown }

const ENTRIES: { pkg: string; ctor: string; opts: (self: URL[]) => object; auto?: boolean }[] = [
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
  { pkg: '@opentelemetry/instrumentation-mysql2', ctor: 'MySQL2Instrumentation', opts: () => ({}), auto: true },
];

/** Drivers patched in place (no OTel package): `instrument: 'auto'` only. Each loads the app's installed copy or is skipped. */
const DRIVERS: { name: string; run: () => void }[] = [
  { name: 'postgres.js', run: () => { load('postgres'); instrumentPostgres(); } }, // only when `postgres` is installed
  { name: 'better-sqlite3', run: () => instrumentBetterSqlite3(load('better-sqlite3') as Parameters<typeof instrumentBetterSqlite3>[0]) },
];

/**
 * Register whichever of the OTel instrumentations is installed (http, undici, pg, ioredis; with `auto` also mysql2) and,
 * with `auto`, patch postgres.js and better-sqlite3 when installed. Returns the names that were enabled.
 */
export function instrumentAll(p: Providers, selfUrls: string[], auto = false): string[] {
  let registerInstrumentations: (o: object) => () => void;
  try {
    ({ registerInstrumentations } = load('@opentelemetry/instrumentation') as { registerInstrumentations: typeof registerInstrumentations });
  } catch {
    return auto ? patchDrivers([]) : []; // optional peer not installed
  }
  const self = selfUrls.flatMap((u) => { try { return [new URL(u)]; } catch { return []; } });
  const found: object[] = [];
  const names: string[] = [];
  for (const e of ENTRIES) {
    if (e.auto && !auto) continue;
    try {
      const Ctor = (load(e.pkg) as Record<string, new (o: object) => object>)[e.ctor];
      if (Ctor) { found.push(new Ctor(e.opts(self))); names.push(e.pkg); }
    } catch {
      // package not installed (or failed to construct): skip it, never break init
    }
  }
  if (found.length) registerInstrumentations({ instrumentations: found, tracerProvider: p.tracerProvider, meterProvider: p.meterProvider });
  return auto ? patchDrivers(names) : names;
}

function patchDrivers(names: string[]): string[] {
  for (const d of DRIVERS) {
    try { d.run(); names.push(d.name); } catch { /* driver not installed */ }
  }
  return names;
}
