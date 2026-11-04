import * as nodePath from 'node:path';
import { observeEmbedded, patch, sizeOf, traced, tracedCb } from './db.js';
import type { DbOptions } from './db.js';

type Proto = Record<string, any>;
interface Ctor { prototype: Proto }
const STATEMENT = ['run', 'get', 'all'];

/** Trace `exec(sql)` and the run/get/all of statements `prepare` returns (their prototype is patched once). */
function patchSync(db: Proto, system: string, opts: DbOptions | undefined,
  sqlOf: (stmt: any) => string | undefined, nsOf: (stmt: any) => string | undefined): void {
  patch(db, 'exec', (orig) => function (this: any, sql: string, ...a: unknown[]) {
    return traced({ system, sql, namespace: nsOf({ database: this }) }, opts, () => orig.call(this, sql, ...a));
  });
  patch(db, 'prepare', (orig) => function (this: unknown, ...a: unknown[]) {
    const stmt = orig.apply(this, a);
    const proto = stmt && Object.getPrototypeOf(stmt);
    if (proto) {
      for (const m of STATEMENT) {
        patch(proto, m, (o) => function (this: any, ...args: unknown[]) {
          return traced({ system, sql: sqlOf(this), namespace: nsOf(this) }, opts, () => o.apply(this, args));
        });
      }
    }
    return stmt;
  });
}

const base = (p: unknown) => (typeof p === 'string' && p && p !== ':memory:' ? nodePath.basename(p) : undefined);

/** `import * as sqlite from 'node:sqlite'; instrumentNodeSqlite(sqlite)`: spans for `DatabaseSync.exec`
 * and prepared `run`/`get`/`all`. shortcut: `iterate()` is not traced (the span would end before the rows). */
export function instrumentNodeSqlite(sqlite: { DatabaseSync: Ctor }, opts?: DbOptions): void {
  patchSync(sqlite.DatabaseSync.prototype, 'sqlite', opts, (s) => s.sourceSQL, () => undefined);
}

/** `import Database from 'better-sqlite3'; instrumentBetterSqlite3(Database)`: spans for `exec` and
 * prepared `run`/`get`/`all`, `db.namespace` = the database file name. */
export function instrumentBetterSqlite3(Database: Ctor, opts?: DbOptions): void {
  patchSync(Database.prototype, 'sqlite', opts, (s) => s.source, (s) => base(s.database?.name));
}

/**
 * Callback drivers (`sqlite3`, classic `duckdb`): trace `run`/`get`/`all`/`exec`/`each` on each
 * prototype; the span ends in the callback, which runs in the caller's context.
 * shortcut: a call without a callback ends its span when the call returns (no duration).
 */
export function patchCallbackDb(protos: Proto[], system: string, opts: DbOptions | undefined): void {
  for (const proto of protos) {
    for (const m of ['run', 'get', 'all', 'exec', 'each']) {
      patch(proto, m, (orig) => function (this: any, ...a: unknown[]) {
        const op = { system, sql: typeof a[0] === 'string' ? a[0] : undefined, namespace: base(this.filename) };
        const call = (args: unknown[]) => orig.apply(this, args);
        // each(sql, ..., row, complete): only the completion callback ends the span
        const cb = m !== 'each' || typeof a[a.length - 2] === 'function';
        return cb ? tracedCb(op, opts, a, call) : traced(op, opts, () => call(a));
      });
    }
  }
}

/** `import sqlite3 from 'sqlite3'; instrumentSqlite3(sqlite3)`: spans for `Database` run/get/all/exec/each.
 * shortcut: `Statement` objects from `db.prepare` are not traced. */
export function instrumentSqlite3(sqlite3: { Database: Ctor }, opts?: DbOptions): void {
  patchCallbackDb([sqlite3.Database.prototype], 'sqlite', opts);
}

interface LibsqlClient { execute(...a: any[]): Promise<unknown>; batch?(...a: any[]): Promise<unknown>;
  executeMultiple?(sql: string): Promise<unknown>; transaction?(...a: any[]): Promise<any> }

/** `instrumentLibsql(createClient({ url }))`: spans for `execute`, `batch`, `executeMultiple` and
 * the same calls on transactions it opens. `db.system.name=sqlite`. Returns the client. */
export function instrumentLibsql<C extends LibsqlClient>(client: C, opts?: DbOptions): C {
  const sqlOf = (s: unknown) => (typeof s === 'string' ? s : (s as { sql?: string } | null)?.sql);
  const wrap = (c: LibsqlClient) => {
    patch(c, 'execute', (orig) => function (this: unknown, stmt: unknown, ...a: unknown[]) {
      return traced({ system: 'sqlite', sql: sqlOf(stmt) }, opts, () => orig.call(this, stmt, ...a));
    });
    patch(c, 'executeMultiple', (orig) => function (this: unknown, sql: string) {
      return traced({ system: 'sqlite', sql }, opts, () => orig.call(this, sql));
    });
    patch(c, 'batch', (orig) => function (this: unknown, stmts: unknown[], ...a: unknown[]) {
      return traced({ system: 'sqlite', operation: 'BATCH',
        attributes: { 'db.operation.batch.size': stmts?.length ?? 0 } }, opts, () => orig.call(this, stmts, ...a));
    });
  };
  wrap(client);
  patch(client, 'transaction', (orig) => async function (this: unknown, ...a: unknown[]) {
    const tx = await orig.apply(this, a);
    if (tx) wrap(tx);
    return tx;
  });
  return client;
}

/** `wt.embedded.file.size` and `wt.embedded.wal.size` (the `-wal` file) of a SQLite database file. Returns `stop()`. */
export function observeSqliteFile(path: string): () => void {
  return observeEmbedded('sqlite', nodePath.basename(path), ['file.size', 'wal.size'],
    () => ({ 'file.size': sizeOf(path), 'wal.size': sizeOf(`${path}-wal`) }));
}
