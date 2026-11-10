import { test, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { metrics, trace } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace';
import { AggregationTemporality, InMemoryMetricExporter, MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import type { DataPoint, Histogram, MetricData } from '@opentelemetry/sdk-metrics';
import * as wt from '../src/index.js';
import { instrumentMongoPool, instrumentMysql2Pool } from '../src/integrations/pools.js';
import { instrumentDrizzle, instrumentTypeORM, kyselyLog, mikroOrmLoggerFactory, sequelizeLogging } from '../src/integrations/orm.js';
// These tests call the drivers outside any span; requireParent (default on) would drop them.
process.env.WATCHTOWER_DB_REQUIRE_PARENT = '0';

type Done = (r: { code: number }) => void;
const spans: ReadableSpan[] = [];
wt.init({
  apiKey: 'test-key-not-real',
  captureProcessErrors: false,
  logs: false,
  metrics: false,
  exporter: { export: (s: ReadableSpan[], done: Done) => { spans.push(...s); done({ code: 0 }); }, shutdown: async () => {}, forceFlush: async () => {} },
});
const reader = new PeriodicExportingMetricReader({
  exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE), exportIntervalMillis: 1e9,
});
metrics.disable();
metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));

async function drain(): Promise<ReadableSpan[]> {
  await wt.flush();
  return spans.splice(0);
}
async function collect(): Promise<MetricData[]> {
  const { resourceMetrics } = await reader.collect();
  return resourceMetrics.scopeMetrics.flatMap((s) => s.metrics);
}
const points = (ms: MetricData[], name: string, pool: string) =>
  (ms.find((m) => m.descriptor.name === name)?.dataPoints ?? [])
    .filter((p) => p.attributes['db.client.connection.pool.name'] === pool) as DataPoint<unknown>[];
const byState = (ms: MetricData[], pool: string) => Object.fromEntries(points(ms, 'db.client.connection.count', pool)
  .map((p) => [p.attributes['db.client.connection.state'], p.value]));

test('mongodb: CMAP events become pool gauges, wait/use time and timeouts', async () => {
  const client = new EventEmitter();
  instrumentMongoPool(client);
  const address = 'db:27017';
  client.emit('connectionPoolCreated', { address, options: { maxPoolSize: 10 } });
  client.emit('connectionCreated', { address, connectionId: 1 });
  client.emit('connectionCreated', { address, connectionId: 2 });
  client.emit('connectionCheckOutStarted', { address });
  client.emit('connectionCheckOutStarted', { address });
  client.emit('connectionCheckedOut', { address, connectionId: 1, durationMS: 5 });
  client.emit('connectionCheckOutFailed', { address, reason: 'timeout', durationMS: 30 });
  let ms = await collect();
  expect(byState(ms, address)).toEqual({ used: 1, idle: 1 });
  expect(points(ms, 'db.client.connection.max', address)[0]!.value).toBe(10);
  expect(points(ms, 'db.client.connection.pending_requests', address)[0]!.value).toBe(0);
  expect(points(ms, 'db.client.connection.timeouts', address)[0]!.value).toBe(1);
  expect((points(ms, 'db.client.connection.wait_time', address)[0]!.value as Histogram).count).toBe(2);
  client.emit('connectionCheckedIn', { address, connectionId: 1 });
  ms = await collect();
  expect(byState(ms, address)).toEqual({ used: 0, idle: 2 });
  expect((points(ms, 'db.client.connection.use_time', address)[0]!.value as Histogram).count).toBe(1);
});

test('mysql2: promise pool internals become pool gauges, acquire/release use time', async () => {
  const core = Object.assign(new EventEmitter(), {
    _allConnections: [{}, {}, {}], _freeConnections: [{}], _connectionQueue: [() => {}],
    config: { connectionLimit: 5, connectionConfig: { host: 'h', port: 3306, database: 'app' } },
  });
  const stop = instrumentMysql2Pool({ pool: core });
  const conn = {};
  core.emit('acquire', conn);
  core.emit('release', conn);
  const ms = await collect();
  expect(byState(ms, 'h:3306/app')).toEqual({ used: 2, idle: 1 });
  expect(points(ms, 'db.client.connection.max', 'h:3306/app')[0]!.value).toBe(5);
  expect(points(ms, 'db.client.connection.pending_requests', 'h:3306/app')[0]!.value).toBe(1);
  expect((points(ms, 'db.client.connection.use_time', 'h:3306/app')[0]!.value as Histogram).count).toBe(1);
  stop();
});

test('drizzle: prepared queries become spans with hash and the N+1 hint', async () => {
  const session = {
    prepareQuery(_q: { sql: string }) {
      return { async execute() { return [1]; }, all() { return this.execute(); } };
    },
  };
  const db = { session };
  instrumentDrizzle(db, 'postgresql');
  instrumentDrizzle(db, 'postgresql'); // idempotent
  await trace.getTracer('t').startActiveSpan('request', async (s) => {
    for (let i = 0; i < 6; i++) await db.session.prepareQuery({ sql: `select * from "users" where id = ${i}` }).all();
    s.end();
  });
  const all = await drain();
  const q = all.filter((s) => s.name === 'SELECT users');
  expect(q).toHaveLength(6); // all() calling execute() adds no second span
  expect(q[0]!.attributes).toMatchObject({ 'db.system.name': 'postgresql', 'db.operation.name': 'SELECT', 'db.collection.name': 'users' });
  expect(new Set(q.map((s) => s.attributes['db.query.hash'])).size).toBe(1);
  expect(q[4]!.attributes['db.n_plus_one']).toBeUndefined();
  expect(q[5]!.attributes).toMatchObject({ 'db.n_plus_one': true, 'db.query.repeat_count': 6 });
  expect(JSON.stringify(q[0]!.attributes)).not.toContain('where id');
});

test('kysely, sequelize and mikro-orm log hooks record finished spans', async () => {
  const seen: unknown[] = [];
  const log = kyselyLog('sqlite', (e) => seen.push(e));
  log({ level: 'query', query: { sql: "select * from pets where name = 'rex'" }, queryDurationMillis: 20 });
  log({ level: 'error', query: { sql: 'delete from pets' }, queryDurationMillis: 1, error: Object.assign(new Error('x'), { code: 'SQLITE_BUSY' }) });
  const next: unknown[][] = [];
  const sq = sequelizeLogging('postgresql', (...a) => next.push(a));
  sq('Executed (default): SELECT "id" FROM "users" WHERE "id" = 1;', 12, {});
  sq('Executing (default): SELECT 1', {}); // no timing (benchmark off): no span
  class Base { logged: unknown[] = []; constructor(public o: object) {} logQuery(c: object) { this.logged.push(c); } }
  const logger = mikroOrmLoggerFactory(Base, 'postgresql')({});
  logger.logQuery({ query: 'select 1 from "books" where title = $1', took: 3 });
  const all = await drain();
  const pets = all.find((s) => s.name === 'SELECT pets')!;
  expect(pets.duration[0] * 1e3 + pets.duration[1] / 1e6).toBeGreaterThanOrEqual(19);
  expect(JSON.stringify(pets.attributes)).not.toContain('rex');
  expect(all.find((s) => s.name === 'DELETE pets')!).toMatchObject({ status: { code: 2 }, attributes: { 'db.response.status_code': 'SQLITE_BUSY' } });
  expect(all.find((s) => s.name === 'SELECT users')!.attributes['db.system.name']).toBe('postgresql');
  expect(all.find((s) => s.name === 'SELECT books')).toBeDefined();
  expect(all).toHaveLength(4);
  expect(seen).toHaveLength(2);
  expect(next).toHaveLength(2);
  expect(logger.logged).toHaveLength(1);
});

test('typeorm: query runner queries become spans with the semconv system name', async () => {
  const runner = { async query(_sql: string) { return []; } };
  const ds = { options: { type: 'postgres', database: 'app' }, driver: { createQueryRunner: () => runner } };
  instrumentTypeORM(ds);
  await ds.driver.createQueryRunner().query('SELECT 1 FROM accounts WHERE id = 5');
  await ds.driver.createQueryRunner().query('SELECT 1 FROM accounts WHERE id = 6'); // same runner, wrapped once
  const all = await drain();
  expect(all.filter((s) => s.name === 'SELECT accounts')).toHaveLength(2);
  expect(all[0]!.attributes).toMatchObject({ 'db.system.name': 'postgresql', 'db.namespace': 'app' });
});
