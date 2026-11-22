// Startup status line, WT_DEBUG logging and drop counters. Wraps the OTLP exporters; never replaces them.
// The ingest key is never printed beyond its first 8 characters.
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace';
import type { LogRecordExporter } from '@opentelemetry/sdk-logs';
import type { PushMetricExporter } from '@opentelemetry/sdk-metrics';

export type Signal = 'traces' | 'logs' | 'metrics';
type State = 'pending' | 'none' | 'ok' | 'off' | `fail(${string})`;
type Result = { code: number; error?: Error };

export const debugOn = (): boolean => ['1', 'true', 'on', 'yes'].includes((process.env.WT_DEBUG ?? process.env.WATCHTOWER_DEBUG ?? '').trim().toLowerCase());
/** First 8 characters only. */
export const keyHint = (k: string): string => `${k.slice(0, 8)}…`;
export const debug = (m: string): void => { if (debugOn()) console.info(`[watchtower:debug] ${m}`); };

/** HTTP status or error text of a failed export (the OTLP exporters put the status in `code` or the message). */
export function failure(e: (Error & { code?: unknown }) | undefined): string {
  const m = /\bstatus(?: code)?:? (\d{3})\b/i.exec(e?.message ?? '');
  return String((typeof e?.code === 'number' ? e.code : undefined) ?? m?.[1] ?? e?.message ?? 'error').split('\n')[0]!.slice(0, 80);
}

const quiet = (): boolean => process.env.NODE_ENV === 'test' && !debugOn();

export class StatusLine {
  private st: Record<Signal, State>;
  private printed = false;
  private warned = false;
  constructor(private readonly o: { service: string; endpoint: string; release?: string; off?: Signal[] }, private readonly out: (m: string) => void = (m) => { if (!quiet()) console.info(m); }, private readonly warn: (m: string) => void = (m) => { if (!quiet()) console.warn(m); }) {
    this.st = { traces: 'pending', logs: 'pending', metrics: 'pending' };
    for (const s of o.off ?? []) this.st[s] = 'off';
    // a signal that never fires (no logs yet, metrics every 60 s) must not hide the line forever
    const t = setTimeout(() => this.expire(), 90_000);
    t.unref?.();
  }
  /** 90 s in: a signal that has exported nothing yet (OTLP exports time out in 10 s) had nothing to send. */
  expire(): void {
    for (const k of Object.keys(this.st) as Signal[]) if (this.st[k] === 'pending') this.st[k] = 'none';
    this.print();
  }
  /** One result for `signal`: the first failure and the last pending signal turning ok both print the line. */
  record(signal: Signal, items: number, r: Result): void {
    const fail = r.code !== 0;
    const why = fail ? failure(r.error) : '';
    debug(`export ${signal} items=${items} ${fail ? `fail(${why})` : 'ok'}`);
    if (fail) {
      if (this.st[signal] !== 'ok') this.st[signal] = `fail(${why})`;
      if (signal === 'traces' && !this.warned) {
        this.warned = true;
        this.warn(`[watchtower] WARNING: trace export to ${this.o.endpoint} failed (${why}). Set WT_OTLP_ENDPOINT to your ingest URL (hosted: https://ingest.watchtowerops.net).`);
      }
      this.print();
      return;
    }
    this.st[signal] = 'ok';
    if (Object.values(this.st).every((s) => s !== 'pending')) this.print();
  }
  print(): void {
    if (this.printed) return;
    this.printed = true;
    let host = this.o.endpoint;
    try { host = new URL(this.o.endpoint).host; } catch { /* keep as given */ }
    const s = this.st;
    this.out(`[watchtower] ${this.o.service} → ${host} traces:${s.traces} logs:${s.logs} metrics:${s.metrics} release=${this.o.release ?? 'none'}`);
  }
}

const countMetrics = (m: unknown): number =>
  ((m as { scopeMetrics?: { metrics: unknown[] }[] })?.scopeMetrics ?? []).reduce((n, s) => n + s.metrics.length, 0);

type Exp<T> = { export(items: T, done: (r: Result) => void): void; shutdown(): Promise<void>; forceFlush?(): Promise<void> };
function watch<T, E extends Exp<T>>(inner: E, signal: Signal, line: StatusLine, count: (i: T) => number): E {
  const wrapped = Object.create(inner) as E; // keeps every other exporter method (selectAggregation etc.)
  (wrapped as Exp<T>).export = (items: T, done: (r: Result) => void) => inner.export(items, (r) => { line.record(signal, count(items), r); done(r); });
  return wrapped;
}
export const watchSpans = (e: SpanExporter, l: StatusLine): SpanExporter => watch<ReadableSpan[], SpanExporter & Exp<ReadableSpan[]>>(e as never, 'traces', l, (i) => i.length);
export const watchLogs = (e: LogRecordExporter, l: StatusLine): LogRecordExporter => watch<unknown[], LogRecordExporter & Exp<unknown[]>>(e as never, 'logs', l, (i) => i.length);
export const watchMetrics = (e: PushMetricExporter, l: StatusLine): PushMetricExporter => watch<unknown, PushMetricExporter & Exp<unknown>>(e as never, 'metrics', l, countMetrics);

// Drop counters: Next-internal spans (sampling) and DB queries without a parent span. Summarised per minute under WT_DEBUG.
const drops = new Map<string, number>();
let timer: ReturnType<typeof setInterval> | undefined;
export function noteDrop(kind: string): void {
  drops.set(kind, (drops.get(kind) ?? 0) + 1);
  if (!timer && debugOn()) {
    timer = setInterval(flushDrops, 60_000);
    timer.unref?.();
  }
}
export function flushDrops(): void {
  if (drops.size) debug(`dropped in the last minute: ${[...drops].map(([k, n]) => `${n} ${k}`).join(', ')}`);
  drops.clear();
}
