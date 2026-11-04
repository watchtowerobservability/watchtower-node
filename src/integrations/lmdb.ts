import * as nodePath from 'node:path';
import { observeEmbedded, patch, sizeOf, traced } from './db.js';
import type { DbOptions } from './db.js';

interface LmdbStats { pageSize?: number; mapSize?: number; lastPageNumber?: number; entryCount?: number; numReaders?: number }
interface LmdbDb {
  path?: string;
  name?: string;
  getStats?(): LmdbStats;
  openDB?(...a: unknown[]): object;
}

const WRITES = ['put', 'remove', 'ifVersion', 'ifNoExists', 'clearAsync', 'drop', 'getMany', 'prefetch'];

/**
 * `instrumentLmdb(open({ path }))` (lmdb-js): spans for async writes (`put`, `remove`, `ifVersion`,
 * `ifNoExists`, `clearAsync`, `drop`), `getMany` and `transaction` (calls inside a transaction get
 * child spans), on the root and on every `openDB` sub-database (`db.collection.name`). Sync reads
 * (`get`) are memory-mapped and take microseconds, so they get no span. With `metrics` (default on)
 * it also reports `wt.embedded.map.size`, `.map.used`, `.entries`, `.readers` and `.file.size`.
 * Returns `stop()` for the gauges.
 */
export function instrumentLmdb(db: LmdbDb, opts?: DbOptions & { metrics?: boolean }): () => void {
  const namespace = db.path ? nodePath.basename(db.path) : undefined;
  const wrap = (d: LmdbDb, collection?: string) => {
    for (const m of WRITES) {
      patch(d, m, (orig) => function (this: unknown, ...a: unknown[]) {
        return traced({ system: 'lmdb', operation: m, collection, namespace }, opts, () => orig.apply(this, a));
      });
    }
    patch(d, 'transaction', (orig) => function (this: unknown, ...a: unknown[]) {
      return traced({ system: 'lmdb', operation: 'transaction', collection, namespace }, opts,
        () => orig.apply(this, a), false);
    });
    patch(d, 'openDB', (orig) => function (this: unknown, ...a: unknown[]) {
      const sub = orig.apply(this, a) as LmdbDb;
      const name = typeof a[0] === 'string' ? a[0] : (a[0] as { name?: string } | undefined)?.name;
      if (sub) wrap(sub, name ?? sub.name);
      return sub;
    });
  };
  wrap(db);
  if (opts?.metrics === false || typeof db.getStats !== 'function') return () => {};
  return observeEmbedded('lmdb', namespace, ['map.size', 'map.used', 'entries', 'readers', 'file.size'], () => {
    const s = db.getStats!();
    const used = s.pageSize !== undefined && s.lastPageNumber !== undefined ? (s.lastPageNumber + 1) * s.pageSize : undefined;
    return {
      'map.size': s.mapSize, 'map.used': used, entries: s.entryCount, readers: s.numReaders,
      'file.size': db.path ? sizeOf(db.path) : undefined,
    };
  });
}
