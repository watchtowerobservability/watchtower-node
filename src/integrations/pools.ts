// Connection-pool metrics (OTel db semconv) for drivers whose pools upstream does not cover.
import { observePool } from './db.js';
import type { PoolState } from './db.js';

export { observePool };
export type { PoolState };

interface Emitter { on(event: string, fn: (e: any) => void): unknown }

/**
 * `instrumentMongoPool(client)` on a `MongoClient` (before or after `connect`): pool gauges per
 * server address from the driver's CMAP events, wait time (driver >= 6.9 reports `durationMS`),
 * use time (check-out to check-in) and check-out timeouts. Call after `init`.
 */
export function instrumentMongoPool(client: Emitter): void {
  type P = { used: number; pending: number; total: number; max?: number; rec: ReturnType<typeof observePool> };
  const pools = new Map<string, P>();
  const out = new Map<string, number>(); // `${address}#${connectionId}` -> checked out at (ms)
  const get = (address: string): P => {
    let p = pools.get(address);
    if (!p) {
      const s = { used: 0, pending: 0, total: 0 } as P;
      s.rec = observePool('mongodb', address, () => ({
        used: s.used, idle: Math.max(0, s.total - s.used), pending: s.pending, max: s.max,
      }));
      pools.set(address, (p = s));
    }
    return p;
  };
  const dec = (n: number) => Math.max(0, n - 1);
  client.on('connectionPoolCreated', (e) => {
    const max = e.options?.maxPoolSize;
    if (typeof max === 'number') get(e.address).max = max;
  });
  client.on('connectionPoolClosed', (e) => {
    pools.get(e.address)?.rec.stop();
    pools.delete(e.address);
  });
  client.on('connectionCreated', (e) => { get(e.address).total++; });
  client.on('connectionClosed', (e) => { const p = get(e.address); p.total = dec(p.total); });
  client.on('connectionCheckOutStarted', (e) => { get(e.address).pending++; });
  client.on('connectionCheckOutFailed', (e) => {
    const p = get(e.address);
    p.pending = dec(p.pending);
    if (e.reason === 'timeout') p.rec.timeout();
    if (typeof e.durationMS === 'number') p.rec.wait(e.durationMS / 1000);
  });
  client.on('connectionCheckedOut', (e) => {
    const p = get(e.address);
    p.pending = dec(p.pending);
    p.used++;
    if (typeof e.durationMS === 'number') p.rec.wait(e.durationMS / 1000);
    out.set(`${e.address}#${e.connectionId}`, Date.now());
  });
  client.on('connectionCheckedIn', (e) => {
    const p = get(e.address);
    p.used = dec(p.used);
    const k = `${e.address}#${e.connectionId}`;
    const t = out.get(k);
    if (t !== undefined) { out.delete(k); p.rec.use((Date.now() - t) / 1000); }
  });
}

interface Mysql2CorePool extends Emitter {
  _allConnections?: { length: number };
  _freeConnections?: { length: number };
  _connectionQueue?: { length: number };
  config?: { connectionLimit?: number; connectionConfig?: { host?: string; port?: number; database?: string } };
}

/**
 * `instrumentMysql2Pool(pool)` on a mysql2 pool (callback or `.promise()` pool): used/idle/pending
 * connections and the limit, plus use time (acquire to release). Name defaults to `host:port/db`.
 * shortcut: no wait time or timeouts (mysql2 has no acquire timeout and does not report queue wait).
 * Returns `stop()`.
 */
export function instrumentMysql2Pool(pool: Mysql2CorePool | { pool: Mysql2CorePool }, name?: string): () => void {
  const core = ('pool' in pool && pool.pool ? pool.pool : pool) as Mysql2CorePool;
  const c = core.config?.connectionConfig;
  const pname = name ?? (c ? `${c.host ?? 'localhost'}:${c.port ?? 3306}${c.database ? `/${c.database}` : ''}` : 'mysql2');
  const rec = observePool('mysql', pname, () => {
    const all = core._allConnections?.length ?? 0;
    const free = core._freeConnections?.length ?? 0;
    return { used: all - free, idle: free, pending: core._connectionQueue?.length ?? 0, max: core.config?.connectionLimit };
  });
  const acquired = new WeakMap<object, number>();
  core.on('acquire', (conn) => { if (conn) acquired.set(conn, Date.now()); });
  core.on('release', (conn) => {
    const t = conn && acquired.get(conn);
    if (t) { acquired.delete(conn); rec.use((Date.now() - t) / 1000); }
  });
  return rec.stop;
}
