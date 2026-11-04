import * as nodePath from 'node:path';
import { observeEmbedded, patch, sizeOf, traced } from './db.js';
import type { DbOptions } from './db.js';
import { patchCallbackDb } from './sqlite.js';

type Proto = Record<string, any>;
const NEO = ['run', 'runAndRead', 'runAndReadAll', 'runAndReadUntil', 'stream', 'streamAndRead', 'streamAndReadAll',
  'streamAndReadUntil'];

/**
 * `import * as duckdb from '@duckdb/node-api'` (or the classic `duckdb` package);
 * `instrumentDuckDB(duckdb)`: a span per statement run on a `DuckDBConnection` (or a classic
 * `Database`/`Connection`), `db.system.name=duckdb`. Returns false when neither API is found.
 * shortcut: prepared statements (`connection.prepare`) are not traced.
 */
export function instrumentDuckDB(duckdb: { DuckDBConnection?: { prototype: Proto };
  Database?: { prototype: Proto }; Connection?: { prototype: Proto } }, opts?: DbOptions): boolean {
  const neo = duckdb.DuckDBConnection?.prototype;
  if (neo) {
    for (const m of NEO) {
      patch(neo, m, (orig) => function (this: unknown, sql: unknown, ...a: unknown[]) {
        return traced({ system: 'duckdb', sql: typeof sql === 'string' ? sql : undefined }, opts,
          () => orig.call(this, sql, ...a));
      });
    }
    return true;
  }
  const protos = [duckdb.Database?.prototype, duckdb.Connection?.prototype].filter((p): p is Proto => !!p);
  patchCallbackDb(protos, 'duckdb', opts);
  return protos.length > 0;
}

/** `wt.embedded.file.size` and `wt.embedded.wal.size` (the `.wal` file) of a DuckDB database file. Returns `stop()`. */
export function observeDuckDBFile(path: string): () => void {
  return observeEmbedded('duckdb', nodePath.basename(path), ['file.size', 'wal.size'],
    () => ({ 'file.size': sizeOf(path), 'wal.size': sizeOf(`${path}.wal`) }));
}
