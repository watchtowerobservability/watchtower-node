import { test, expect } from 'vitest';
import { metrics, trace } from '@opentelemetry/api';
import { MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import * as wt from '../src/index.js';
import { instrumentBetterSqlite3, instrumentLibsql, instrumentNodeSqlite, instrumentSqlite3 } from '../src/integrations/sqlite.js';
import { instrumentDuckDB } from '../src/integrations/duckdb.js';
import { instrumentLmdb } from '../src/integrations/lmdb.js';
import { instrumentLevel } from '../src/integrations/level.js';
import { instrumentKeyv, instrumentLruCache, instrumentNodeCache } from '../src/integrations/cache.js';
import { normalizeAndHash } from '../src/sql.js';

type Done = (r: { code: number }) => void;
const spans: ReadableSpan[] = [];
wt.init({
  apiKey: 'test-key-not-real',
  captureProcessErrors: false,
  logs: false,
  metrics: false,
  exporter: { export: (s: ReadableSpan[], done: Done) => { spans.push(...s); done({ code: 0 }); }, shutdown: async () => {}, forceFlush: async () => {} },
});
class Reader extends MetricReader {
  protected async onForceFlush() {}
  protected async onShutdown() {}
}
const reader = new Reader();
metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));

async function drain(): Promise<ReadableSpan[]> {
  await wt.flush();
  return spans.splice(0);
}
async function value(name: string, attrs: Record<string, unknown>): Promise<number | undefined> {
  const { resourceMetrics } = await reader.collect();
  const m = resourceMetrics.scopeMetrics.flatMap((s) => s.metrics).find((x) => x.descriptor.name === name);
  const p = m?.dataPoints.find((d) => Object.entries(attrs).every(([k, v]) => d.attributes[k] === v));
  return p?.value as number | undefined;
}
const job = (fn: () => Promise<void> | void) => trace.getTracer('t').startActiveSpan('job', async (s) => { await fn(); s.end(); });

test('node:sqlite: statement spans with hash, N+1 hint, no values, driver error code', async () => {
  class StatementSync {
    constructor(public sourceSQL: string) {}
    get() { return { id: 1 }; }
    run() { return { changes: 1 }; }
    all() { return []; }
  }
  class DatabaseSync {
    exec(sql: string) { if (sql.includes('boom')) throw Object.assign(new Error("near 'secret'"), { code: 'ERR_SQLITE_ERROR' }); }
    prepare(sql: string) { return new StatementSync(sql); }
  }
  instrumentNodeSqlite({ DatabaseSync });
  const db = new DatabaseSync();
  await job(() => {
    for (let i = 0; i < 7; i++) db.prepare(`select * from users where id = ${i}`).get();
    db.exec("insert into logs (msg) values ('secret')");
    expect(() => db.exec('boom')).toThrow();
  });
  const all = await drain();
  const parent = all.find((s) => s.name === 'job')!;
  const sel = all.filter((s) => s.name === 'SELECT users');
  expect(sel).toHaveLength(7);
  expect(sel[0]!.parentSpanId).toBe(parent.spanContext().spanId);
  expect(new Set(sel.map((s) => s.attributes['db.query.hash'])).size).toBe(1);
  expect(sel[0]!.attributes['db.query.hash']).toBe(normalizeAndHash('select * from users where id = ?')[1]);
  expect(sel[0]!.attributes).toMatchObject({ 'db.system.name': 'sqlite', 'db.operation.name': 'SELECT', 'db.collection.name': 'users' });
  expect(sel.map((s) => s.attributes['db.query.repeat_count'])).toEqual([undefined, undefined, undefined, undefined, undefined, 6, 7]);
  expect(sel[6]!.attributes['db.n_plus_one']).toBe(true);
  expect(JSON.stringify(all.map((s) => s.attributes))).not.toContain('secret');
  const err = all.find((s) => s.attributes['error.type'] === 'ERR_SQLITE_ERROR')!;
  expect(err.status).toEqual({ code: 2 });
});

test('better-sqlite3: opt-in literal-free text and the file name as namespace', async () => {
  class Statement {
    database = { name: '/srv/app/app.db' };
    constructor(public source: string) {}
    run() { return {}; }
  }
  class Database {
    prepare(sql: string) { return new Statement(sql); }
  }
  instrumentBetterSqlite3(Database, { queryText: true });
  new Database().prepare("update t set a = 'x' where id = 4").run();
  const [s] = await drain();
  expect(s!.attributes).toMatchObject({ 'db.query.text': 'update t set a = ? where id = ?', 'db.namespace': 'app.db' });
});

test('sqlite3 (callbacks): the span ends in the callback, which keeps its this and the caller context', async () => {
  class Database {
    filename = 'cb.db';
    run(_sql: string, cb: (this: any, e: Error | null) => void) { setImmediate(() => cb.call({ lastID: 3 }, null)); }
    all(_sql: string, _p: unknown[], cb: (e: Error | null, rows?: unknown[]) => void) {
      setImmediate(() => cb(Object.assign(new Error('x'), { code: 'SQLITE_BUSY' })));
    }
  }
  instrumentSqlite3({ Database });
  const db = new Database();
  let seen: unknown;
  let active: string | undefined;
  await job(() => new Promise<void>((done) => {
    db.run('delete from t where id = 1', function (this: { lastID: number }) {
      seen = this.lastID;
      active = trace.getActiveSpan()?.spanContext().spanId;
      db.all('select 1', [], () => done());
    });
  }));
  const all = await drain();
  const parent = all.find((s) => s.name === 'job')!;
  expect(seen).toBe(3);
  expect(active).toBe(parent.spanContext().spanId);
  expect(all.find((s) => s.name === 'DELETE t')!.attributes['db.namespace']).toBe('cb.db');
  expect(all.find((s) => s.name === 'SELECT')!.attributes['db.response.status_code']).toBe('SQLITE_BUSY');
});

test('libsql and duckdb: one span per call, internal calls not doubled', async () => {
  const client = instrumentLibsql({
    execute: async (_s: unknown) => ({ rows: [] }),
    batch: async (_s: unknown[]) => [],
    transaction: async () => ({ execute: async (_s: unknown) => ({}) }),
  });
  await client.execute({ sql: 'select * from notes where id = ?', args: [1] });
  await client.batch(['insert into a values (1)', 'insert into a values (2)']);
  await (await client.transaction()).execute('delete from notes');
  class DuckDBConnection {
    async run(_sql: string) { return {}; }
    async runAndReadAll(sql: string) { return this.run(sql); }
  }
  expect(instrumentDuckDB({ DuckDBConnection })).toBe(true);
  await new DuckDBConnection().runAndReadAll('select count(*) from events');
  const names = (await drain()).map((s) => `${s.attributes['db.system.name']}:${s.name}`);
  expect(names).toEqual(['sqlite:SELECT notes', 'sqlite:BATCH', 'sqlite:DELETE notes', 'duckdb:SELECT events']);
});

test('lmdb: write and transaction spans (children inside the transaction), map gauges', async () => {
  const db = {
    path: '/nonexistent/data.mdb',
    put: async (_k: string, _v: unknown) => true,
    transaction: async (fn: () => unknown) => fn(),
    getStats: () => ({ pageSize: 4096, mapSize: 1 << 20, lastPageNumber: 9, entryCount: 3, numReaders: 1 }),
    openDB: (_name: string) => ({ put: async () => true }),
  };
  const stop = instrumentLmdb(db);
  await db.transaction(() => db.put('k', 'v'));
  await db.openDB('users').put();
  const all = await drain();
  const tx = all.find((s) => s.name === 'transaction')!;
  const [inner, sub] = all.filter((s) => s.name.startsWith('put'));
  expect(inner!.parentSpanId).toBe(tx.spanContext().spanId);
  expect(sub!.attributes).toMatchObject({ 'db.system.name': 'lmdb', 'db.collection.name': 'users', 'db.namespace': 'data.mdb' });
  expect(await value('wt.embedded.map.used', { 'db.system.name': 'lmdb' })).toBe(40960);
  expect(await value('wt.embedded.entries', { 'db.system.name': 'lmdb' })).toBe(3);
  stop();
});

test('level/rocksdb: promise and callback ops, sublevels, chained batch untouched', async () => {
  const db = {
    location: '/nonexistent/db',
    get(_k: string, cb?: (e: Error | null, v?: string) => void) {
      if (cb) { setImmediate(() => cb(null, 'v')); return undefined; }
      return Promise.resolve('v');
    },
    batch(ops?: unknown[]) { return ops ? Promise.resolve() : { chained: true }; },
    sublevel: (_n: string) => ({ get: async (_k: string) => 'x' }),
  };
  instrumentLevel(db, { system: 'rocksdb' });
  await db.get('a');
  await new Promise<void>((done) => db.get('b', () => done()));
  await db.batch([{ type: 'put' }]);
  expect(db.batch()).toEqual({ chained: true });
  await db.sublevel('users').get('c');
  const all = await drain();
  expect(all.map((s) => s.name)).toEqual(['get', 'get', 'batch', 'get users']);
  expect(all[0]!.attributes).toMatchObject({ 'db.system.name': 'rocksdb', 'db.namespace': 'db' });
});

test('caches: hit and miss counters, entry gauges', async () => {
  const store = new Map([['a', 1]]);
  const nc = {
    get: (k: string) => store.get(k),
    mget: (ks: string[]) => Object.fromEntries(ks.filter((k) => store.has(k)).map((k) => [k, store.get(k)])),
    getStats: () => ({ keys: store.size }),
  };
  instrumentNodeCache(nc, 'sessions');
  nc.get('a');
  nc.get('zz');
  nc.mget(['a', 'b', 'c']);
  const lru = { size: 1, get: (k: string) => store.get(k) };
  instrumentLruCache(lru);
  lru.get('nope');
  const keyv = { get: async (k: string | string[]) => (Array.isArray(k) ? k.map((x) => store.get(x)) : store.get(k)) };
  instrumentKeyv(keyv);
  await keyv.get(['a', 'q']);
  await Promise.resolve();
  const nca = { 'db.system.name': 'node-cache', 'db.namespace': 'sessions' };
  expect(await value('wt.embedded.cache.hits', nca)).toBe(2);
  expect(await value('wt.embedded.cache.misses', nca)).toBe(3);
  expect(await value('wt.embedded.cache.entries', nca)).toBe(1);
  expect(await value('wt.embedded.cache.misses', { 'db.system.name': 'lru-cache' })).toBe(1);
  expect(await value('wt.embedded.cache.hits', { 'db.system.name': 'keyv' })).toBe(1);
  expect(await value('wt.embedded.cache.misses', { 'db.system.name': 'keyv' })).toBe(1);
});
