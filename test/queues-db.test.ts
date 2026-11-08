import { test, expect } from 'vitest';
import * as dc from 'node:diagnostics_channel';
import { trace } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace';
import * as wt from '../src/index.js';
import { CONTEXT_KEY, instrumentBullMQ } from '../src/integrations/bullmq.js';
import { instrumentPostgres, querySummary } from '../src/integrations/postgres.js';

type Done = (r: { code: number }) => void;
const spans: ReadableSpan[] = [];
wt.init({
  apiKey: 'test-key-not-real',
  captureProcessErrors: false,
  logs: false,
  metrics: false,
  exporter: { export: (s: ReadableSpan[], done: Done) => { spans.push(...s); done({ code: 0 }); }, shutdown: async () => {}, forceFlush: async () => {} },
});
async function drain(): Promise<ReadableSpan[]> {
  await wt.flush();
  return spans.splice(0);
}

interface Job { id: string; name: string; data: any; opts: { delay?: number }; attemptsMade: number }
class Queue {
  jobs: Job[] = [];
  constructor(public name: string) {}
  async add(name: string, data: unknown, opts: { delay?: number } = {}): Promise<Job> {
    const j = { id: String(this.jobs.length + 1), name, data: structuredClone(data), opts, attemptsMade: 0 };
    this.jobs.push(j);
    return j;
  }
  async addBulk(js: Array<{ name: string; data: unknown }>): Promise<Job[]> {
    return js.map((j) => {
      const job = { id: String(this.jobs.length + 1), name: j.name, data: structuredClone(j.data), opts: {}, attemptsMade: 0 };
      this.jobs.push(job);
      return job;
    });
  }
}
class Worker {
  constructor(public name: string, private fn: (j: Job) => Promise<unknown>) {}
  callProcessJob(job: Job, _token: string): Promise<unknown> {
    return this.fn(job);
  }
}

test('bullmq: producer and consumer spans share a trace through job data', async () => {
  expect(instrumentBullMQ({ Queue, Worker } as never)).toBe(true);
  expect(instrumentBullMQ({ Queue, Worker } as never)).toBe(true); // idempotent
  const q = new Queue('emails');
  await trace.getTracer('t').startActiveSpan('request', async (s) => {
    await q.add('welcome', { to: 'a' }, { delay: 500 });
    s.end();
  });
  await q.addBulk([{ name: 'b1', data: { n: 1 } }, { name: 'b2', data: { n: 2 } }]);
  expect(q.jobs[0]!.data[CONTEXT_KEY].traceparent).toMatch(/^00-/);

  const seen: unknown[] = [];
  const w = new Worker('emails', async (j) => void seen.push(j.data));
  await w.callProcessJob(q.jobs[0]!, 'tok');
  await expect(new Worker('emails', async () => { throw new Error('nope'); }).callProcessJob(q.jobs[1]!, 't')).rejects.toThrow('nope');
  expect(seen).toEqual([{ to: 'a' }]);

  const all = await drain();
  const req = all.find((s) => s.name === 'request')!;
  const [send, bulk] = all.filter((s) => s.name === 'send emails');
  const [ok, failed] = all.filter((s) => s.name === 'process emails');
  expect(send!.parentSpanContext?.spanId).toBe(req.spanContext().spanId);
  expect(send!.attributes).toMatchObject({
    'messaging.system': 'bullmq', 'messaging.destination.name': 'emails', 'messaging.operation.type': 'send',
    'messaging.message.id': '1', 'messaging.bullmq.job.delay_ms': 500,
  });
  expect(bulk!.attributes['messaging.batch.message_count']).toBe(2);
  expect(ok!.spanContext().traceId).toBe(req.spanContext().traceId);
  expect(ok!.parentSpanContext?.spanId).toBe(send!.spanContext().spanId);
  expect(ok!.attributes).toMatchObject({ 'messaging.operation.type': 'process', 'messaging.bullmq.job.attempt': 1 });
  expect(failed!.parentSpanContext?.spanId).toBe(bulk!.spanContext().spanId);
  expect(failed!.status.code).toBe(2);
});

test('postgres: summary never carries values', () => {
  expect(querySummary("select * from users where email = 'x@y'")).toEqual({ operation: 'SELECT', target: 'users', summary: 'SELECT users' });
  expect(querySummary('insert into "app"."jobs" (a) values ($1)').summary).toBe('INSERT app.jobs');
  expect(querySummary('with t as (select 1) update accounts set a = 1').summary).toBe('UPDATE accounts');
  expect(querySummary(null).summary).toBe('postgres');
});

test('postgres: postgres:query channel becomes client spans with SQLSTATE', async () => {
  const off = instrumentPostgres();
  const ch = dc.tracingChannel('postgres:query');
  await trace.getTracer('t').startActiveSpan('job', async (s) => {
    await ch.tracePromise(async () => ({ command: 'SELECT', count: 1 }),
      { query: "select id from users where name = 'secret'", database: 'app', host: 'db', port: 5432, count: 3 });
    await expect(ch.tracePromise(async () => { throw Object.assign(new Error('duplicate key value (id)=(42)'), { code: '23505' }); },
      { query: 'insert into users (id) values ($1)', database: 'app' })).rejects.toThrow();
    s.end();
  });
  off();
  const all = await drain();
  const job = all.find((s) => s.name === 'job')!;
  const sel = all.find((s) => s.name === 'SELECT users')!;
  const ins = all.find((s) => s.name === 'INSERT users')!;
  expect(sel.parentSpanContext?.spanId).toBe(job.spanContext().spanId);
  expect(sel.kind).toBe(2); // CLIENT
  expect(sel.attributes).toMatchObject({ 'db.system': 'postgresql', 'db.operation.name': 'SELECT', 'db.namespace': 'app', 'server.port': 5432 });
  expect(JSON.stringify(sel.attributes)).not.toContain('secret');
  expect(ins.attributes['db.response.status_code']).toBe('23505');
  expect(ins.status).toMatchObject({ code: 2, message: 'SQLSTATE 23505' });
  expect(JSON.stringify(ins.attributes)).not.toContain('42');
});
