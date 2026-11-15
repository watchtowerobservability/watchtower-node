// Cron monitors for `@nestjs/schedule` (`@Cron`) and `node-cron`: each job becomes a monitor via `withMonitor`.
import { monitorJob, slugify } from './monitor.js';
import type { MonitorOptions } from './monitor.js';

type Fn = (...a: any[]) => unknown;
const DONE = Symbol.for('watchtower.cron.wrapped');

interface CronJobLike {
  cronTime?: { source?: unknown; zone?: unknown; timeZone?: unknown };
  _callbacks?: Fn[];
  [DONE]?: boolean;
}
interface SchedulerRegistryLike {
  addCronJob: (name: string, job: CronJobLike) => unknown;
  getCronJobs: () => Map<string, CronJobLike>;
  [DONE]?: boolean;
}

/** Wrap one `cron` CronJob's callbacks. False when this `cron` version keeps them elsewhere than `_callbacks`. */
function wrapJob(name: string, job: CronJobLike): boolean {
  const slug = slugify(name); // a Nest job without `{ name }` gets a uuid: nothing stable to monitor
  if (!slug || job[DONE] || !Array.isArray(job._callbacks)) return false;
  job[DONE] = true;
  const src = job.cronTime?.source;
  const tz = job.cronTime?.zone ?? job.cronTime?.timeZone;
  const o: MonitorOptions = { schedule: typeof src === 'string' ? src : undefined, timezone: typeof tz === 'string' ? tz : undefined };
  job._callbacks = job._callbacks.map((cb) => function (this: unknown, ...a: unknown[]) { return monitorJob(slug, () => cb.apply(this, a), o); });
  return true;
}

/**
 * `instrumentNestSchedule(app.get(SchedulerRegistry))` after `app.init()` (or in `onApplicationBootstrap`): every `@Cron`
 * job, already registered or added later, runs as a monitor named after its `@Cron(expr, { name })` (kebab-cased) with its
 * cron expression and timezone as the schedule. Give jobs a name; unnamed ones (uuid) are skipped. Returns how many were wrapped now.
 * shortcut: reads the `cron` package's private `_callbacks` (cron 3 and 4); a version that moves it wraps nothing.
 */
export function instrumentNestSchedule(registry: SchedulerRegistryLike): number {
  let n = 0;
  for (const [name, job] of registry.getCronJobs()) if (wrapJob(name, job)) n++;
  if (!registry[DONE]) {
    registry[DONE] = true;
    const add = registry.addCronJob;
    registry.addCronJob = function (this: unknown, name: string, job: CronJobLike) {
      wrapJob(name, job);
      return add.call(this, name, job);
    };
  }
  return n;
}

interface NodeCronLike { schedule: (expr: string, fn: Fn, opts?: { name?: string; timezone?: string }) => unknown }

/**
 * `import cron from 'node-cron'; instrumentNodeCron(cron)`: tasks scheduled afterwards with `cron.schedule(expr, fn, { name })`
 * run as monitors (a function's own name is not used: bundlers rename them). Pass the default export (a CommonJS object), not an ESM namespace.
 * Returns false when it cannot patch it.
 */
export function instrumentNodeCron(cron: NodeCronLike): boolean {
  const orig = cron.schedule;
  if (typeof orig !== 'function' || (orig as unknown as Record<symbol, unknown>)[DONE]) return false;
  const wrapped = function (this: unknown, expr: string, fn: Fn, opts?: { name?: string; timezone?: string }, ...rest: unknown[]) {
    const slug = typeof fn === 'function' ? slugify(opts?.name || '') : '';
    if (!slug) return (orig as (...a: unknown[]) => unknown).call(this, expr, fn, opts, ...rest);
    const o: MonitorOptions = { schedule: expr, timezone: opts?.timezone };
    return (orig as (...a: unknown[]) => unknown).call(this, expr, function (this: unknown, ...a: unknown[]) { return monitorJob(slug, () => fn.apply(this, a), o); }, opts, ...rest);
  };
  (wrapped as unknown as Record<symbol, unknown>)[DONE] = true;
  try {
    cron.schedule = wrapped as NodeCronLike['schedule'];
  } catch {
    return false;
  }
  return cron.schedule === wrapped;
}
