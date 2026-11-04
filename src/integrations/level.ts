import * as nodePath from 'node:path';
import { observeEmbedded, patch, sizeOf, tracedCb } from './db.js';
import type { DbOptions } from './db.js';

interface LevelDb { location?: string; sublevel?(...a: unknown[]): object }

const OPS = ['get', 'getMany', 'put', 'del', 'batch', 'clear'];

/**
 * `instrumentLevel(new ClassicLevel(dir))`, or `instrumentLevel(rocksdb(dir), { system: 'rocksdb' })`:
 * a span per `get`/`getMany`/`put`/`del`/`batch`/`clear` (promise or callback form; keys and values
 * are never recorded), on the db and on its sublevels (`db.collection.name`). With `metrics` (default
 * on) and a `location`, `wt.embedded.file.size` reports the size of the store's directory.
 * Returns `stop()` for the gauge.
 * shortcut: iterators and the chained `batch()` builder are not traced.
 */
export function instrumentLevel(db: LevelDb, opts?: DbOptions & { system?: 'leveldb' | 'rocksdb'; metrics?: boolean }): () => void {
  const system = opts?.system ?? 'leveldb';
  const namespace = db.location ? nodePath.basename(db.location) : undefined;
  const wrap = (d: LevelDb, collection?: string) => {
    for (const m of OPS) {
      patch(d, m, (orig) => function (this: unknown, ...a: unknown[]) {
        if (m === 'batch' && a.length === 0) return orig.call(this); // chained builder
        return tracedCb({ system, operation: m, collection, namespace }, opts, a, (args) => orig.apply(this, args));
      });
    }
    patch(d, 'sublevel', (orig) => function (this: unknown, ...a: unknown[]) {
      const sub = orig.apply(this, a) as LevelDb;
      if (sub) wrap(sub, typeof a[0] === 'string' ? a[0] : undefined);
      return sub;
    });
  };
  wrap(db);
  const dir = db.location;
  if (opts?.metrics === false || !dir) return () => {};
  return observeEmbedded(system, namespace, ['file.size'], () => ({ 'file.size': sizeOf(dir) }));
}
