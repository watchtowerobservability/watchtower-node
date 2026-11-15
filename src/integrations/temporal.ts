// Temporal: activity spans + final-attempt failure capture (worker interceptors), and Schedule check-ins (a poller).
// Duck-typed on purpose: nothing from @temporalio/* is imported, so there is no dependency and the SDK's workflow sandbox is untouched.
import { context, trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { captureException } from '../errors.js';
import { checkIn, currentTarget, normalizeCron, slugify } from '../cron/monitor.js';
import type { CheckInStatus, MonitorConfig } from '../cron/monitor.js';

interface ActivityInfo {
  activityType?: string; activityId?: string; attempt?: number; taskQueue?: string;
  workflowType?: string; workflowExecution?: { workflowId?: string; runId?: string };
  retryPolicy?: { maximumAttempts?: number };
}
interface ActivityCtx { info?: ActivityInfo }
type Next = (input: unknown) => Promise<unknown>;

export interface TemporalInterceptorOptions {
  /** Retry cap when the activity info does not carry the retry policy; a failure on this attempt (or a non-retryable one) is captured. */
  maxAttempts?: number;
}

/** Worker options fragment: `Worker.create({ ..., interceptors: temporalInterceptors() })`. Spans for each activity attempt; the exception is captured on the final attempt only. */
export function temporalInterceptors(o: TemporalInterceptorOptions = {}) {
  return {
    activity: [
      (ctx: ActivityCtx) => ({
        inbound: {
          async execute(input: unknown, next: Next): Promise<unknown> {
            const i = ctx.info ?? {};
            const attempt = i.attempt ?? 1;
            const span = trace.getTracer('watchtower').startSpan(`activity ${i.activityType ?? 'unknown'}`, {
              kind: SpanKind.CONSUMER,
              attributes: {
                'temporal.activity.type': i.activityType ?? '', 'temporal.activity.id': i.activityId ?? '', 'temporal.attempt': attempt,
                'temporal.task_queue': i.taskQueue ?? '', 'temporal.workflow.id': i.workflowExecution?.workflowId ?? '',
                'temporal.workflow.type': i.workflowType ?? '',
              },
            });
            try {
              return await context.with(trace.setSpan(context.active(), span), () => next(input));
            } catch (e) {
              const max = o.maxAttempts ?? i.retryPolicy?.maximumAttempts;
              const final = (e as { nonRetryable?: boolean })?.nonRetryable === true || (!!max && attempt >= max);
              if (final) captureException(e, { attributes: { 'temporal.activity.type': i.activityType, 'temporal.attempt': attempt, 'temporal.workflow.id': i.workflowExecution?.workflowId } });
              else { span.recordException(e as Error); span.setStatus({ code: SpanStatusCode.ERROR, message: (e as Error)?.message }); }
              throw e;
            } finally {
              span.end();
            }
          },
        },
      }),
    ],
  };
}

// ---- schedules ----

interface Range { start?: number; end?: number; step?: number }
type Calendar = Partial<Record<'minute' | 'hour' | 'dayOfMonth' | 'month' | 'dayOfWeek', Range[]>>;
interface WfRef { workflowId?: string; firstExecutionRunId?: string; runId?: string }
interface ActionLike { takenAt?: Date | string; workflow?: WfRef; action?: { workflow?: WfRef } }
interface Described {
  spec?: { cronExpressions?: string[]; calendars?: Calendar[]; timezoneName?: string };
  info?: { recentActions?: ActionLike[]; runningActions?: ActionLike[] };
}
export interface TemporalClientLike {
  options?: { namespace?: string };
  schedule: { list(): AsyncIterable<{ scheduleId: string }>; getHandle(id: string): { describe(): Promise<Described> } };
  workflow: { getHandle(id: string, runId?: string): { describe(): Promise<{ status?: { name?: string }; startTime?: Date; closeTime?: Date }> } };
}
export interface WatchSchedulesOptions {
  /** Poll period; default 60_000. */
  interval?: number;
  /** Only watch when the client's namespace is one of these (a Temporal client is bound to one namespace). */
  namespaces?: string[];
}

const FULL: Record<string, [number, number]> = { dayOfMonth: [1, 31], month: [1, 12], dayOfWeek: [0, 6] };
function field(name: string, rs?: Range[], dflt = '*'): string {
  if (!rs?.length) return dflt;
  const full = FULL[name];
  const parts = rs.map((r) => {
    const s = r.start ?? 0, e = r.end ?? s, st = r.step && r.step > 1 ? r.step : 1;
    if (full && s === full[0] && e === full[1] && st === 1) return '*';
    return s === e ? `${s}` : `${s}-${e}${st > 1 ? `/${st}` : ''}`;
  });
  return parts.includes('*') ? '*' : parts.join(',');
}

/** Crontab (5 fields) for a Temporal schedule spec, or undefined when it has none or is not expressible (intervals, several calendars). */
export function scheduleCron(spec: Described['spec']): { cron: string; timezone?: string } | undefined {
  let tz = spec?.timezoneName || undefined;
  const raw = spec?.cronExpressions?.[0];
  if (raw) {
    const m = /^(?:CRON_TZ|TZ)=(\S+)\s+(.*)$/.exec(raw.trim());
    if (m) { tz = m[1]; }
    return { cron: normalizeCron((m ? m[2]! : raw).split(/\s+/).slice(0, 6).join(' ')), timezone: tz };
  }
  const cal = spec?.calendars;
  if (cal?.length !== 1) return undefined;
  const c = cal[0]!;
  return { cron: ['minute', 'hour', 'dayOfMonth', 'month', 'dayOfWeek'].map((k) => field(k, c[k as keyof Calendar], k === 'minute' || k === 'hour' ? '0' : '*')).join(' '), timezone: tz };
}

const OK = new Set(['COMPLETED']);
const BAD = new Set(['FAILED', 'TIMED_OUT', 'TERMINATED', 'CANCELLED']);
const ref = (a: ActionLike): WfRef | undefined => a.workflow ?? a.action?.workflow;

/** Poll Temporal Schedules and send a check-in per action (slug `temporal-<scheduleId>`). Returns a stop function. */
export function watchTemporalSchedules(client: TemporalClientLike, o: WatchSchedulesOptions = {}): () => void {
  if (o.namespaces && !o.namespaces.includes(client.options?.namespace ?? 'default')) return () => undefined;
  const seen = new Map<string, 'running' | 'done'>(); // schedule + workflow run -> last status sent
  let busy = false;
  const poll = async (): Promise<void> => {
    const target = currentTarget();
    if (!target || busy) return;
    busy = true;
    try {
      for await (const s of client.schedule.list()) {
        const slug = `temporal-${slugify(s.scheduleId) || s.scheduleId}`;
        const d = await client.schedule.getHandle(s.scheduleId).describe();
        const cr = scheduleCron(d.spec);
        const monitorConfig: MonitorConfig | undefined = cr && { schedule: { type: 'crontab', value: cr.cron }, ...(cr.timezone ? { timezone: cr.timezone } : {}) };
        const send = (st: CheckInStatus, durationMs?: number) => checkIn(target, slug, st, { wait: true, monitorConfig, durationMs });
        const actions = [...(d.info?.runningActions ?? []), ...(d.info?.recentActions ?? [])];
        for (const a of actions) {
          const w = ref(a);
          if (!w?.workflowId) continue;
          const key = `${s.scheduleId}\0${w.workflowId}\0${w.firstExecutionRunId ?? w.runId ?? ''}`;
          if (seen.get(key) === 'done') continue;
          let name = 'RUNNING', dur: number | undefined;
          try {
            const wd = await client.workflow.getHandle(w.workflowId, w.firstExecutionRunId ?? w.runId).describe();
            name = String(wd.status?.name ?? 'RUNNING');
            if (wd.startTime && wd.closeTime) dur = +new Date(wd.closeTime) - +new Date(wd.startTime);
          } catch { continue; } // describe failed: retry next poll
          if (name === 'RUNNING') { if (!seen.has(key)) { seen.set(key, 'running'); await send('in_progress'); } }
          else if (OK.has(name) || BAD.has(name)) {
            if (!seen.has(key)) await send('in_progress'); // short run seen only after it finished
            seen.set(key, 'done');
            await send(OK.has(name) ? 'ok' : 'error', dur);
          }
        }
      }
    } catch { /* Temporal unreachable: try again next interval */ } finally { busy = false; }
  };
  const t = setInterval(() => void poll(), o.interval ?? 60_000);
  t.unref?.();
  void poll();
  return () => clearInterval(t);
}
