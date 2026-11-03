// Error capture: an exception becomes an OTel span event (exception.*) with trace and span ids.
import { trace, SpanStatusCode } from '@opentelemetry/api';

const captured = new WeakMap<Error, string>(); // error object -> traceId, so framework + process hooks never double-report

export interface CaptureContext {
  /** false for crashes (uncaught); default true. Keys starting with `wt.` are dropped. */
  handled?: boolean;
  attributes?: Record<string, string | number | boolean | undefined>;
}

/** The slice of `process` the hooks need; tests pass an EventEmitter. */
export interface ProcessLike {
  on(event: string, listener: (arg: unknown) => void): unknown;
  off(event: string, listener: (arg: unknown) => void): unknown;
  listenerCount(event: string): number;
  exit(code?: number): unknown;
}

export function dropReserved<T>(attrs?: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(attrs || {}).filter(([k]) => !k.startsWith('wt.')));
}

/** Record err on the active span (or a new `exception` span). Returns the trace id. */
export function captureException(err: unknown, ctx?: CaptureContext): string {
  const o = ctx || {};
  const e = err instanceof Error ? err : new Error(typeof err === 'string' ? err : JSON.stringify(err));
  const seen = captured.get(e);
  if (seen !== undefined) return seen;
  const attrs = { 'error.handled': o.handled !== false, ...dropReserved(o.attributes) };
  const active = trace.getActiveSpan();
  const span = active && active.isRecording() ? active : trace.getTracer('watchtower').startSpan('exception');
  span.setAttributes(attrs);
  span.recordException(e);
  span.setStatus({ code: SpanStatusCode.ERROR, message: e.message });
  const traceId = span.spanContext().traceId;
  if (span !== active) span.end();
  captured.set(e, traceId);
  return traceId;
}

/** uncaughtException / unhandledRejection hooks. Exits like Node would, but only when we are the sole listener. */
export function installProcessHandlers(flush: () => Promise<unknown>, proc?: ProcessLike): () => void {
  const p: ProcessLike = proc || process;
  const exitAfterFlush = () =>
    Promise.race([flush(), new Promise((r) => setTimeout(r, 2000).unref())]).finally(() => p.exit(1));
  const onException = (e: unknown) => {
    captureException(e, { handled: false, attributes: { 'error.mechanism': 'uncaughtException' } });
    if (p.listenerCount('uncaughtException') > 1) return;
    console.error(e);
    exitAfterFlush();
  };
  const onRejection = (reason: unknown) => {
    captureException(reason, { handled: false, attributes: { 'error.mechanism': 'unhandledRejection' } });
    if (p.listenerCount('unhandledRejection') > 1) return;
    console.error(reason);
    exitAfterFlush();
  };
  p.on('uncaughtException', onException);
  p.on('unhandledRejection', onRejection);
  return () => {
    p.off('uncaughtException', onException);
    p.off('unhandledRejection', onRejection);
  };
}
