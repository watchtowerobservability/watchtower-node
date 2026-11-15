// Cron monitor check-ins: POST {edge}/v1/checkins/{slug} (key scope `ingest:checkins`; the edge accepts 6 a minute per monitor).
import { context } from '@opentelemetry/api';
import type { CheckinTarget } from '../checkin.js';

export type CheckInStatus = 'in_progress' | 'ok' | 'error';

/** Sent in the check-in body so the server can create or update the monitor on first contact (Sentry's `monitor_config` shape, minutes). */
export interface MonitorConfig {
  schedule: { type: 'crontab'; value: string };
  timezone?: string;
  checkin_margin_m?: number;
  max_runtime_m?: number;
  failure_threshold?: number;
}

export interface MonitorOptions {
  /** Crontab, 5 fields (or 6 with leading seconds, which are dropped when they are `0`). */
  schedule?: string;
  timezone?: string;
  /** Minutes a check-in may be late before it counts as missed. */
  checkinMargin?: number;
  /** Minutes a run may stay `in_progress` before it counts as failed. */
  maxRuntime?: number;
  /** Consecutive failures before an issue opens. */
  failureThreshold?: number;
  /** Await the check-in requests (default false: fire and forget, capped at 5 s). Use it in short-lived processes. */
  wait?: boolean;
}

export interface CheckInOptions {
  wait?: boolean;
  durationMs?: number;
  monitorConfig?: MonitorConfig;
  /** Default 5000. */
  timeoutMs?: number;
}

/** The client `init()` made (the one per-process state `index.ts` keeps), without importing it. */
export function currentTarget(): CheckinTarget | undefined {
  const s = (globalThis as Record<symbol, unknown>)[Symbol.for('watchtower.node.state')] as { current?: CheckinTarget } | undefined;
  return s?.current;
}

/** Check-ins are served by the edge host, not the OTLP gateway: `ingest.x` becomes `edge.x`. `WT_CHECKIN_URL` overrides. */
export function checkinBase(endpoint: string): string {
  const env = process.env.WT_CHECKIN_URL;
  if (env) return env.replace(/\/+$/, '');
  return endpoint.replace(/^(https?:\/\/)ingest\./i, '$1edge.');
}

// `0 */5 * * * *` -> `*/5 * * * *`; a 6-field expression with another seconds value stays as it is.
export function normalizeCron(expr: string): string {
  const f = expr.trim().split(/\s+/);
  return f.length === 6 && /^0+$/.test(f[0]!) ? f.slice(1).join(' ') : f.join(' ');
}

export function toConfig(o: MonitorOptions): MonitorConfig | undefined {
  if (typeof o.schedule !== 'string' || !o.schedule.trim()) return undefined;
  const c: MonitorConfig = { schedule: { type: 'crontab', value: normalizeCron(o.schedule) } };
  if (o.timezone) c.timezone = o.timezone;
  if (o.checkinMargin !== undefined) c.checkin_margin_m = o.checkinMargin;
  if (o.maxRuntime !== undefined) c.max_runtime_m = o.maxRuntime;
  if (o.failureThreshold !== undefined) c.failure_threshold = o.failureThreshold;
  return c;
}

// The OTel SDK's own key (`@opentelemetry/core` suppressTracing), so our HTTP call makes no span.
const SUPPRESS = Symbol.for('OpenTelemetry SDK Context Key SUPPRESS_TRACING');

/** Send one check-in. Never throws or rejects; without `wait` it returns at once and the request is capped at 5 s. */
export function checkIn(c: CheckinTarget, slug: string, status: CheckInStatus, o: CheckInOptions = {}): Promise<void> {
  const ms = o.durationMs === undefined ? undefined : Math.min(Math.max(Math.round(o.durationMs), 0), 86_400_000);
  const url = `${checkinBase(c.endpoint)}/v1/checkins/${encodeURIComponent(slug)}?status=${status}${ms === undefined ? '' : `&duration_ms=${ms}`}`;
  const body: Record<string, unknown> = { status };
  if (ms !== undefined) body.duration_ms = ms;
  if (o.monitorConfig) body.monitor_config = o.monitorConfig;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), o.timeoutMs ?? 5000);
  timer.unref?.();
  let p: Promise<void>;
  try {
    p = context.with(context.active().setValue(SUPPRESS, true), () =>
      c.fetch(url, { method: 'POST', headers: { ...c.headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ac.signal }))
      .then(() => undefined, () => undefined);
  } catch {
    p = Promise.resolve();
  }
  p = p.finally(() => clearTimeout(timer));
  return o.wait ? p : Promise.resolve();
}

/** Run `fn` as a monitored job: `in_progress`, then `ok` or `error` with the duration. Returns fn's result or rethrows its error; check-in failures never reach it. */
export async function withMonitor<T>(c: CheckinTarget, slug: string, fn: () => T | Promise<T>, o: MonitorOptions = {}): Promise<T> {
  const monitorConfig = toConfig(o);
  const send = (status: CheckInStatus, durationMs?: number) => checkIn(c, slug, status, { wait: o.wait, durationMs, monitorConfig });
  await send('in_progress');
  const t = Date.now();
  try {
    const r = await fn();
    await send('ok', Date.now() - t);
    return r;
  } catch (e) {
    await send('error', Date.now() - t);
    throw e;
  }
}

/** Lowercase kebab slug of a job or method name (`MyService.nightlyReport` -> `my-service-nightly-report`). Empty for a uuid. */
export function slugify(name: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name)) return '';
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

/** `withMonitor` against the client `init()` made; just runs `fn` when there is none. */
export function monitorJob<T>(slug: string, fn: () => T | Promise<T>, o: MonitorOptions = {}): Promise<T> {
  const c = currentTarget();
  return c ? withMonitor(c, slug, fn, o) : Promise.resolve().then(fn);
}
