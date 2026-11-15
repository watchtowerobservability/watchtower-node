import { test, expect } from 'vitest';
import { checkIn, checkinBase, normalizeCron, slugify, withMonitor } from '../src/cron/monitor.js';
import { instrumentNestSchedule, instrumentNodeCron } from '../src/cron/schedulers.js';
import { instrumentBullMQ } from '../src/integrations/bullmq.js';

interface Call { url: string; init: RequestInit }
function target(fail = false) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (fail) throw new Error('network down');
    return new Response('{}');
  }) as unknown as typeof fetch;
  return { calls, c: { endpoint: 'https://ingest.example.net', headers: { Authorization: 'Bearer k' }, fetch: f } };
}
const body = (c: Call) => JSON.parse(String(c.init.body));

test('checkin base moves ingest.* to edge.* and WT_CHECKIN_URL wins', () => {
  expect(checkinBase('https://ingest.watchtowerops.net')).toBe('https://edge.watchtowerops.net');
  expect(checkinBase('http://localhost:4318')).toBe('http://localhost:4318');
  process.env.WT_CHECKIN_URL = 'http://x/';
  expect(checkinBase('https://ingest.a.b')).toBe('http://x');
  delete process.env.WT_CHECKIN_URL;
});

test('checkIn is fire and forget, never throws, and awaits only with wait', async () => {
  const { c, calls } = target(true);
  await expect(checkIn(c, 'job', 'ok')).resolves.toBeUndefined();
  await expect(checkIn(c, 'job', 'error', { wait: true, durationMs: 5 })).resolves.toBeUndefined();
  expect(calls[0]!.url).toBe('https://edge.example.net/v1/checkins/job?status=ok');
  expect(calls[1]!.url).toBe('https://edge.example.net/v1/checkins/job?status=error&duration_ms=5');
  expect((calls[1]!.init.signal as AbortSignal).aborted).toBe(false);
  const slow = { ...c, fetch: ((_u: string, i: RequestInit) => new Promise((_r, rej) => i.signal!.addEventListener('abort', () => rej(new Error('abort'))))) as unknown as typeof fetch };
  await expect(checkIn(slow, 'job', 'ok', { wait: true, timeoutMs: 10 })).resolves.toBeUndefined();
});

test('withMonitor sends the schedule config, returns the result and rethrows', async () => {
  const { c, calls } = target();
  const r = await withMonitor(c, 'nightly', () => 7, { schedule: '0 0 3 * * *', timezone: 'UTC', checkinMargin: 5, maxRuntime: 30, failureThreshold: 2, wait: true });
  expect(r).toBe(7);
  expect(body(calls[0]!)).toEqual({ status: 'in_progress', monitor_config: {
    schedule: { type: 'crontab', value: '0 3 * * *' }, timezone: 'UTC', checkin_margin_m: 5, max_runtime_m: 30, failure_threshold: 2 } });
  expect(body(calls[1]!)).toMatchObject({ status: 'ok', monitor_config: { timezone: 'UTC' } });
  expect(typeof body(calls[1]!).duration_ms).toBe('number');
  await expect(withMonitor(c, 'n', () => { throw new Error('boom'); }, { wait: true })).rejects.toThrow('boom');
  const last = calls[calls.length - 1]!;
  expect(body(last).status).toBe('error');
  expect(body(last).monitor_config).toBeUndefined();
});

test('cron helpers', () => {
  expect(normalizeCron('0 */5 * * * *')).toBe('*/5 * * * *');
  expect(normalizeCron('*/10 * * * * *')).toBe('*/10 * * * * *');
  expect(normalizeCron('0  0 * * *')).toBe('0 0 * * *');
  expect(slugify('MyService.nightlyReport')).toBe('my-service-nightly-report');
  expect(slugify('2b1c7a3e-0f2e-4c52-9a73-5d1f0c1e9b11')).toBe('');
});

test('nest schedule: wraps registered and later jobs, skips unnamed', async () => {
  const { c, calls } = target();
  const g = globalThis as Record<symbol, unknown>;
  const prev = g[Symbol.for('watchtower.node.state')];
  g[Symbol.for('watchtower.node.state')] = { current: c };
  const ran: string[] = [];
  const mk = (src: string) => ({ cronTime: { source: src, zone: 'Europe/Paris' }, _callbacks: [async () => { ran.push(src); }] });
  const jobs = new Map<string, ReturnType<typeof mk>>([['Nightly Report', mk('0 0 3 * * *')], ['2b1c7a3e-0f2e-4c52-9a73-5d1f0c1e9b11', mk('* * * * *')]]);
  const registry = { getCronJobs: () => jobs, addCronJob: (n: string, j: ReturnType<typeof mk>) => jobs.set(n, j) };
  expect(instrumentNestSchedule(registry as never)).toBe(1);
  registry.addCronJob('late-job', mk('*/5 * * * *'));
  await jobs.get('Nightly Report')!._callbacks[0]!();
  await jobs.get('late-job')!._callbacks[0]!();
  await new Promise((r) => setTimeout(r, 20));
  expect(ran).toEqual(['0 0 3 * * *', '*/5 * * * *']);
  const first = calls.find((x) => x.url.includes('/checkins/nightly-report?status=in_progress'))!;
  expect(body(first).monitor_config).toEqual({ schedule: { type: 'crontab', value: '0 3 * * *' }, timezone: 'Europe/Paris' });
  expect(calls.some((x) => x.url.includes('/checkins/late-job?status=ok'))).toBe(true);
  g[Symbol.for('watchtower.node.state')] = prev;
});

test('node-cron: named tasks become monitors, unnamed ones pass through', async () => {
  const { c, calls } = target();
  const g = globalThis as Record<symbol, unknown>;
  const prev = g[Symbol.for('watchtower.node.state')];
  g[Symbol.for('watchtower.node.state')] = { current: c };
  const sched: Array<{ expr: string; fn: () => unknown }> = [];
  const cron = { schedule: (expr: string, fn: () => unknown, _opts?: unknown) => void sched.push({ expr, fn }) };
  expect(instrumentNodeCron(cron)).toBe(true);
  expect(instrumentNodeCron(cron)).toBe(false);
  cron.schedule('*/5 * * * *', async () => 1, { name: 'sync-users' } as never);
  const bare = () => 2;
  cron.schedule('* * * * *', bare);
  expect(sched[1]!.fn).toBe(bare);
  await sched[0]!.fn();
  await new Promise((r) => setTimeout(r, 20));
  expect(calls.map((x) => x.url)).toContain('https://edge.example.net/v1/checkins/sync-users?status=in_progress');
  g[Symbol.for('watchtower.node.state')] = prev;
});

test('bullmq: captureFailures only on the final attempt; repeatable jobs become monitors', async () => {
  const { c, calls } = target();
  const g = globalThis as Record<symbol, unknown>;
  const prev = g[Symbol.for('watchtower.node.state')];
  g[Symbol.for('watchtower.node.state')] = { current: c };
  class Queue { constructor(public name: string) {} add() { return Promise.resolve(undefined); } addBulk() { return Promise.resolve([]); } }
  class Worker {
    constructor(public name: string, private fn: () => Promise<unknown>) {}
    callProcessJob(_j: unknown) { return this.fn(); }
  }
  instrumentBullMQ({ Queue, Worker } as never, { captureFailures: true, cronMonitors: true });
  const fail = new Worker('emails', async () => { throw new Error('nope'); });
  const job = (made: number) => ({ id: '9', name: 'send', data: {}, attemptsMade: made, opts: { attempts: 3 } });
  await expect(fail.callProcessJob(job(0))).rejects.toThrow('nope');
  await expect(fail.callProcessJob(job(2))).rejects.toThrow('nope');
  const rep = { id: 'r', name: 'digest', data: {}, attemptsMade: 0, opts: { repeat: { pattern: '0 0 8 * * *', tz: 'UTC' } } };
  await new Worker('mail', async () => 'ok').callProcessJob(rep);
  await new Promise((r) => setTimeout(r, 20));
  const mon = calls.filter((x) => x.url.includes('/checkins/mail-digest?'));
  expect(mon.map((x) => body(x).status)).toEqual(['in_progress', 'ok']);
  expect(body(mon[0]!).monitor_config.schedule.value).toBe('0 8 * * *');
  g[Symbol.for('watchtower.node.state')] = prev;
});
