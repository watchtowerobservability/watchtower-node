import { cacheCounters, observeEmbedded, patch } from './db.js';

/** Count hits and misses of `get`-like methods: `undefined` is a miss; arrays and objects count per key. */
function count(c: ReturnType<typeof cacheCounters>, keys: unknown, v: unknown): void {
  if (Array.isArray(keys)) {
    const found = Array.isArray(v) ? v.filter((x) => x !== undefined).length
      : v && typeof v === 'object' ? Object.keys(v).length : 0;
    c.hit(found);
    c.miss(keys.length - found);
  } else if (v === undefined) {
    c.miss();
  } else {
    c.hit();
  }
}

function wrapGets(cache: object, system: string, name: string, methods: string[]) {
  const c = cacheCounters(system, name);
  for (const m of methods) {
    patch(cache, m, (orig) => function (this: unknown, key: unknown, ...a: unknown[]) {
      const v = orig.call(this, key, ...a);
      if (v && typeof (v as PromiseLike<unknown>).then === 'function') {
        (v as Promise<unknown>).then((x) => count(c, key, x), () => {});
      } else {
        count(c, key, v);
      }
      return v;
    });
  }
}

/** Hit/miss counters and entry count for a node-cache instance (`get`, `mget`). Returns `stop()`. */
export function instrumentNodeCache(cache: { getStats?(): { keys?: number } }, name = 'default'): () => void {
  wrapGets(cache, 'node-cache', name, ['get', 'mget']);
  return observeEmbedded('node-cache', name, ['cache.entries'], () => ({ 'cache.entries': cache.getStats?.().keys }));
}

/** Hit/miss counters and entry count for an lru-cache instance (`get`). Returns `stop()`.
 * shortcut: `fetch()` (the async loader) is not counted. */
export function instrumentLruCache(cache: { size?: number }, name = 'default'): () => void {
  wrapGets(cache, 'lru-cache', name, ['get']);
  return observeEmbedded('lru-cache', name, ['cache.entries'], () => ({ 'cache.entries': cache.size }));
}

/** Hit/miss counters for a Keyv instance (`get` with one key or an array; also `getMany`). */
export function instrumentKeyv(keyv: object, name = 'default'): void {
  wrapGets(keyv, 'keyv', name, ['get', 'getMany']);
}
