import { test, expect } from 'vitest';
import { temporalInterceptors, watchTemporalSchedules, scheduleCron } from '../src/integrations/temporal.js';
import type { TemporalClientLike } from '../src/integrations/temporal.js';

const stateKey = Symbol.for('watchtower.node.state');

test('activity interceptor passes results, rethrows, and captures only the final attempt', async () => {
  const mk = (attempt: number, max?: number) => (temporalInterceptors({ maxAttempts: max }).activity[0]!({ info: { activityType: 'a', attempt } }) as { inbound: { execute(i: unknown, n: (i: unknown) => Promise<unknown>): Promise<unknown> } }).inbound;
  await expect(mk(1).execute(1, async (x) => (x as number) + 1)).resolves.toBe(2);
  await expect(mk(1, 3).execute(1, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
  const nr = Object.assign(new Error('nr'), { nonRetryable: true });
  await expect(mk(1, 3).execute(1, async () => { throw nr; })).rejects.toBe(nr);
});

test('scheduleCron converts cron expressions (with CRON_TZ) and one simple calendar', () => {
  expect(scheduleCron({ cronExpressions: ['CRON_TZ=Europe/Paris 0 */5 * * * *'] })).toEqual({ cron: '*/5 * * * *', timezone: 'Europe/Paris' });
  expect(scheduleCron({ cronExpressions: ['0 3 * * *'] })?.cron).toBe('0 3 * * *');
  expect(scheduleCron({ calendars: [{ minute: [{ start: 30 }], hour: [{ start: 9, end: 17 }], dayOfWeek: [{ start: 1, end: 5 }], month: [{ start: 1, end: 12 }], dayOfMonth: [{ start: 1, end: 31 }] }] })?.cron).toBe('30 9-17 * * 1-5');
  expect(scheduleCron({ calendars: [{}, {}] })).toBeUndefined();
});

test('watchTemporalSchedules sends in_progress then ok/error once per action', async () => {
  const calls: { url: string; body: any }[] = [];
  (globalThis as Record<symbol, unknown>)[stateKey] = {
    current: {
      endpoint: 'https://ingest.example.net', headers: {},
      fetch: async (url: string, init: RequestInit) => { calls.push({ url, body: JSON.parse(String(init.body)) }); return new Response('{}'); },
    },
  };
  let wfStatus = 'RUNNING';
  const wf = (id: string) => ({ workflowId: id, firstExecutionRunId: 'r' + id });
  const client: TemporalClientLike = {
    schedule: {
      async *list() { yield { scheduleId: 'Nightly Sync' }; },
      getHandle: () => ({ describe: async () => ({ spec: { cronExpressions: ['0 2 * * *'] }, info: { runningActions: [], recentActions: [{ takenAt: new Date(), action: { workflow: wf('w1') } }] } }) }),
    },
    workflow: { getHandle: () => ({ describe: async () => ({ status: { name: wfStatus } }) }) },
  };
  const stop = watchTemporalSchedules(client, { interval: 20 });
  await new Promise((r) => setTimeout(r, 80));
  expect(calls.map((c) => c.body.status)).toEqual(['in_progress']); // deduped across polls
  expect(calls[0]!.url).toContain('/v1/checkins/temporal-nightly-sync');
  expect(calls[0]!.body.monitor_config.schedule.value).toBe('0 2 * * *');
  wfStatus = 'FAILED';
  await new Promise((r) => setTimeout(r, 80));
  stop();
  expect(calls.map((c) => c.body.status)).toEqual(['in_progress', 'error']);
  const n = calls.length;
  await new Promise((r) => setTimeout(r, 60));
  expect(calls.length).toBe(n);
  delete (globalThis as Record<symbol, unknown>)[stateKey];
});
