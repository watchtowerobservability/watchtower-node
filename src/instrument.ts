// Auto-instrumentation: node:http, fetch (undici), pg, ioredis (dependencies), mysql2 (optional peer) and the in-place driver patches, each only when installed.
import { load } from './load.js';
import { instrumentBetterSqlite3 } from './integrations/sqlite.js';
import { instrumentPostgres } from './integrations/postgres.js';
import { METADATA_HOSTS } from './env.js';
import { routeNamer } from './integrations/util.js';

/** Instrumentation packages already registered in this process (by `init` or `instrument()`), so none is patched twice. */
export const registered = new Set<string>();

interface Providers { tracerProvider: unknown; meterProvider?: unknown }

const hostOf = (o?: string): string => { try { return new URL(o ?? '').hostname; } catch { return ''; } };

const ENTRIES: { pkg: string; ctor: string; opts: (self: URL[]) => object }[] = [
  {
    pkg: '@opentelemetry/instrumentation-http', ctor: 'HttpInstrumentation',
    // our own exports and API calls must not become spans
    // routeNamer: server spans become `GET /users/:id` from the matched Express / Nest route (http alone names them just `GET`)
    opts: (self) => ({ applyCustomAttributesOnSpan: routeNamer, ignoreOutgoingRequestHook: (r: { hostname?: string; host?: string; port?: string | number }) =>
      METADATA_HOSTS.has(String(r.hostname || r.host).replace(/:\d+$/, '')) || self.some((u) => (r.hostname || r.host) === u.hostname && String(r.port ?? (u.protocol === 'https:' ? 443 : 80)) === String(u.port || (u.protocol === 'https:' ? 443 : 80))) }),
  },
  {
    pkg: '@opentelemetry/instrumentation-undici', ctor: 'UndiciInstrumentation',
    opts: (self) => ({ ignoreRequestHook: (r: { origin?: string }) => METADATA_HOSTS.has(hostOf(r.origin)) || self.some((u) => r.origin === u.origin) }),
  },
  { pkg: '@opentelemetry/instrumentation-pg', ctor: 'PgInstrumentation', opts: () => ({}) },
  { pkg: '@opentelemetry/instrumentation-ioredis', ctor: 'IORedisInstrumentation', opts: () => ({}) },
  { pkg: '@opentelemetry/instrumentation-mysql2', ctor: 'MySQL2Instrumentation', opts: () => ({}) },
];

/** What `npm i` installs to fix an empty instrumented list (the same packages are dependencies of this SDK). */
export const INSTRUMENTATION_PKGS = ['instrumentation', 'instrumentation-http', 'instrumentation-undici', 'instrumentation-pg', 'instrumentation-ioredis'].map((n) => `@opentelemetry/${n}`);

/** Register one entry by package name (for `instrument(name)`); false when already registered or not installed. Uses the global providers. */
export function instrumentOne(pkg: string, selfUrls: string[] = []): boolean {
  const e = ENTRIES.find((x) => x.pkg === pkg);
  if (!e || registered.has(pkg)) return false;
  const self = selfUrls.flatMap((u) => { try { return [new URL(u)]; } catch { return []; } });
  try {
    const { registerInstrumentations } = load('@opentelemetry/instrumentation') as { registerInstrumentations: (o: object) => () => void };
    const Ctor = (load(pkg) as Record<string, new (o: object) => object>)[e.ctor];
    if (!Ctor) return false;
    registerInstrumentations({ instrumentations: [new Ctor(e.opts(self))] });
    registered.add(pkg);
    return true;
  } catch { return false; } // peer not installed
}

/** Drivers patched in place (no OTel package). Each loads the app's installed copy or is skipped. */
const DRIVERS: { name: string; run: () => void }[] = [
  { name: 'postgres.js', run: () => { load('postgres'); instrumentPostgres(); } }, // only when `postgres` is installed
  { name: 'better-sqlite3', run: () => instrumentBetterSqlite3(load('better-sqlite3') as Parameters<typeof instrumentBetterSqlite3>[0]) },
];

/**
 * Register whichever of the OTel instrumentations is installed (http, undici, pg, ioredis, mysql2) and patch postgres.js and
 * better-sqlite3 when installed. Returns the names that were enabled.
 */
export function instrumentAll(p: Providers, selfUrls: string[]): string[] {
  let registerInstrumentations: (o: object) => () => void;
  try {
    ({ registerInstrumentations } = load('@opentelemetry/instrumentation') as { registerInstrumentations: typeof registerInstrumentations });
  } catch {
    return patchDrivers([]); // @opentelemetry/instrumentation not installed
  }
  const self = selfUrls.flatMap((u) => { try { return [new URL(u)]; } catch { return []; } });
  const found: object[] = [];
  const names: string[] = [];
  for (const e of ENTRIES) {
    try {
      const Ctor = (load(e.pkg) as Record<string, new (o: object) => object>)[e.ctor];
      if (Ctor) { found.push(new Ctor(e.opts(self))); names.push(e.pkg); registered.add(e.pkg); }
    } catch {
      // package not installed (or failed to construct): skip it, never break init
    }
  }
  if (found.length) registerInstrumentations({ instrumentations: found, tracerProvider: p.tracerProvider, meterProvider: p.meterProvider });
  return patchDrivers(names);
}

function patchDrivers(names: string[]): string[] {
  for (const d of DRIVERS) {
    try { d.run(); names.push(d.name); } catch { /* driver not installed */ }
  }
  return names;
}
