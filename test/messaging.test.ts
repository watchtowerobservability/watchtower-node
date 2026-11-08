import { EventEmitter } from 'node:events';
import { test, expect } from 'vitest';
import { trace } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace';
import * as wt from '../src/index.js';
import { instrumentAmqplib, instrumentRabbitmqClient } from '../src/integrations/amqp.js';
import { instrumentNats } from '../src/integrations/nats.js';
import { instrumentMqtt } from '../src/integrations/mqtt.js';
import { instrumentPgBoss } from '../src/integrations/pg-boss.js';
import { instrumentAddJob, wrapTaskList } from '../src/integrations/graphile-worker.js';

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
const inRequest = <T>(fn: () => Promise<T>) =>
  trace.getTracer('t').startActiveSpan('request', async (s) => { try { return await fn(); } finally { s.end(); } });

/** The consumer is a child of, and linked to, the producer, in the request's trace. */
function expectChained(all: ReadableSpan[], producer: string, consumer: string) {
  const req = all.find((s) => s.name === 'request')!;
  const p = all.find((s) => s.name === producer && s.kind === 3)!;
  const c = all.find((s) => s.name === consumer && s.kind === 4)!;
  expect(p.parentSpanContext?.spanId).toBe(req.spanContext().spanId);
  expect(c.parentSpanContext?.spanId).toBe(p.spanContext().spanId);
  expect(c.links[0]!.context.spanId).toBe(p.spanContext().spanId);
  return { p, c };
}

test('amqplib: one producer span for sendToQueue, headers carry context, consumer chained, errors marked', async () => {
  class Channel {
    sent: Array<{ ex: string; rk: string; opts: any }> = [];
    fn?: (m: unknown) => unknown;
    publish(ex: string, rk: string, _c: Buffer, opts: any) { this.sent.push({ ex, rk, opts }); return true; }
    sendToQueue(q: string, c: Buffer, o: any) { return this.publish('', q, c, o); }
    consume(_q: string, fn: (m: unknown) => unknown) { this.fn = fn; return Promise.resolve({ consumerTag: 'c1' }); }
  }
  const ch = new Channel();
  instrumentAmqplib(ch);
  instrumentAmqplib(ch); // idempotent
  await inRequest(async () => ch.sendToQueue('jobs', Buffer.from('hi'), { messageId: 'm1', headers: { app: 'x' } }));
  const headers = ch.sent[0]!.opts.headers;
  expect(headers.app).toBe('x');
  expect(headers.traceparent).toMatch(/^00-/);
  await ch.consume('jobs', async () => {});
  await ch.fn!({ content: Buffer.from('hi'), fields: { deliveryTag: 7, redelivered: true }, properties: { headers } });
  await ch.fn!(null); // consumer cancelled: no span (the failed span below is the second process span)
  await ch.consume('jobs', () => { throw Object.assign(new Error('boom'), { code: 'E_X' }); });
  expect(() => ch.fn!({ content: Buffer.from(''), fields: {}, properties: {} })).toThrow('boom');
  const all = await drain();
  expect(all.filter((s) => s.kind === 3)).toHaveLength(1);
  const { p, c } = expectChained(all, 'publish jobs', 'process jobs');
  expect(p.attributes).toMatchObject({
    'messaging.system': 'rabbitmq', 'messaging.destination.name': 'jobs', 'messaging.message.id': 'm1',
    'messaging.message.body.size': 2, 'messaging.rabbitmq.destination.routing_key': 'jobs',
  });
  expect(c.attributes).toMatchObject({ 'messaging.rabbitmq.message.delivery_tag': 7, 'messaging.rabbitmq.message.redelivered': true });
  const failed = all.filter((s) => s.name === 'process jobs')[1]!;
  expect(failed.status.code).toBe(2);
  expect(failed.attributes['error.type']).toBe('E_X');
});

test('rabbitmq-client: publisher.send and consumer handler', async () => {
  const sent: any[] = [];
  let handler: (m: unknown) => Promise<unknown> = async () => {};
  const rabbit = {
    createPublisher: () => ({ async send(env: unknown, _body?: unknown) { sent.push(env); } }),
    createConsumer: (_p: unknown, h: (m: unknown) => Promise<unknown>) => { handler = h; return {}; },
  };
  instrumentRabbitmqClient(rabbit);
  const pub = rabbit.createPublisher();
  await inRequest(() => pub.send('orders', 'x'));
  await inRequest(() => pub.send({ exchange: 'ex', routingKey: 'rk', headers: { a: 1 } }, 'y'));
  expect(sent[0]).toMatchObject({ routingKey: 'orders' });
  expect(sent[1].headers.a).toBe(1);
  rabbit.createConsumer({ queue: 'orders' }, async () => {});
  await handler({ headers: sent[0].headers, deliveryTag: 1 });
  const all = await drain();
  expectChained(all, 'publish orders', 'process orders');
  expect(all.find((s) => s.name === 'publish ex')!.attributes['messaging.rabbitmq.destination.routing_key']).toBe('rk');
});

test('nats: publish headers, callback and iterator subscriptions', async () => {
  const hdrs = () => { const m = new Map<string, string>(); return { get: (k: string) => m.get(k) ?? '', set: (k: string, v: string) => void m.set(k, v) }; };
  const queue: any[] = [];
  let cb: ((e: unknown, m: unknown) => void) | undefined;
  class Conn {
    publish(subject: string, data: Uint8Array, o: any) { queue.push({ subject, data, headers: o.headers }); }
    async request(subject: string, data: Uint8Array, o: any) { this.publish(subject, data, o); return { subject, data }; }
    subscribe(_s: string, o?: any) {
      if (o?.callback) { cb = o.callback; return {}; }
      return { async *[Symbol.asyncIterator]() { while (queue.length) yield queue.shift(); } };
    }
  }
  const nc = new Conn();
  instrumentNats(nc, { headers: hdrs });
  await inRequest(async () => nc.publish('a.b', new Uint8Array(3), undefined as never));
  expect(queue[0].headers.get('traceparent')).toMatch(/^00-/);
  nc.subscribe('a.b', { callback: () => {} });
  cb!(null, queue[0]);
  for await (const m of nc.subscribe('a.b') as AsyncIterable<unknown>) expect(m).toBeTruthy();
  await inRequest(() => nc.request('svc', new Uint8Array(1), {}));
  queue.length = 0;
  const all = await drain();
  const [req1] = all.filter((s) => s.name === 'request');
  const pub = all.find((s) => s.name === 'send a.b')!;
  expect(pub.parentSpanContext?.spanId).toBe(req1!.spanContext().spanId);
  const consumers = all.filter((s) => s.name === 'process a.b');
  expect(consumers).toHaveLength(2); // callback + iterator
  for (const c of consumers) expect(c.links[0]!.context.spanId).toBe(pub.spanContext().spanId);
  expect(all.filter((s) => s.name === 'send svc')).toHaveLength(1); // request's inner publish is not a second span
});

test('mqtt: v5 user properties carry context; message listeners run in the consumer span', async () => {
  class Client extends EventEmitter {
    options = { protocolVersion: 5 };
    out: any[] = [];
    publish(topic: string, message: string, opts: any, cb?: () => void) { this.out.push({ topic, message, opts }); cb?.(); return this; }
  }
  const client = new Client();
  instrumentMqtt(client);
  await inRequest(async () => client.publish('t/1', 'hello', { qos: 1 }));
  const up = client.out[0].opts.properties.userProperties;
  expect(up.traceparent).toMatch(/^00-/);
  expect(client.out[0].opts.qos).toBe(1);
  let active: string | undefined;
  client.on('message', () => { active = trace.getActiveSpan()?.spanContext().spanId; });
  client.emit('message', 't/1', Buffer.from('hello'), { messageId: 9, properties: { userProperties: up } });
  const all = await drain();
  const { c } = expectChained(all, 'publish t/1', 'process t/1');
  expect(active).toBe(c.spanContext().spanId);
  expect(c.attributes['messaging.message.id']).toBe('9');
});

test('pg-boss: send injects _wt, work strips it; batches link every job', async () => {
  const jobs: any[] = [];
  let handler: (a: unknown) => Promise<unknown> = async () => {};
  const boss = {
    async send(name: string, data: unknown) { jobs.push({ id: `j${jobs.length + 1}`, name, data: structuredClone(data) }); return `j${jobs.length}`; },
    async insert(js: any[]) { for (const j of js) jobs.push({ id: `j${jobs.length + 1}`, ...structuredClone(j) }); },
    async work(_name: string, ...rest: any[]) { handler = rest.at(-1); return 'w1'; },
  };
  instrumentPgBoss(boss);
  await inRequest(() => boss.send('mail', { to: 'a' }));
  await boss.insert([{ name: 'mail', data: { n: 1 } }, { name: 'mail', data: { n: 2 } }]);
  expect(jobs[0].data._wt.traceparent).toMatch(/^00-/);
  const seen: unknown[] = [];
  await boss.work('mail', { batchSize: 1 }, async (js: any[]) => void seen.push(js[0].data));
  await handler([jobs[0]]);
  await handler([jobs[1], jobs[2]]);
  expect(seen[0]).toEqual({ to: 'a' });
  const all = await drain();
  const { p } = expectChained(all, 'send mail', 'process mail');
  expect(p.attributes['messaging.message.id']).toBe('j1');
  const batch = all.filter((s) => s.name === 'process mail')[1]!;
  expect(batch.links).toHaveLength(2);
  expect(batch.attributes['messaging.batch.message_count']).toBe(2);
});

test('graphile-worker: addJob payload carries context into the wrapped task', async () => {
  const added: any[] = [];
  const utils = { async addJob(identifier: string, payload: unknown) { added.push({ identifier, payload: structuredClone(payload) }); return { id: '42' }; } };
  instrumentAddJob(utils);
  await inRequest(() => utils.addJob('send_email', { to: 'a' }));
  let got: unknown;
  const tasks = wrapTaskList({
    send_email: async (payload: unknown, _h: unknown) => { got = payload; },
    broken: async (_p: unknown, _h: unknown) => { throw new Error('no'); },
  });
  await tasks.send_email(added[0].payload, { job: { id: '42', attempts: 1 } } as never);
  await expect(tasks.broken({}, {} as never)).rejects.toThrow('no');
  expect(got).toEqual({ to: 'a' });
  const all = await drain();
  const { p, c } = expectChained(all, 'send send_email', 'process send_email');
  expect(p.attributes['messaging.message.id']).toBe('42');
  expect(c.attributes['messaging.graphile_worker.job.attempt']).toBe(1);
  expect(all.find((s) => s.name === 'process broken')!.status.code).toBe(2);
});
