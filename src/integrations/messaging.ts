// Shared core for queue and broker integrations: PRODUCER spans that hand out W3C headers, and
// CONSUMER spans parented by (and linked to) the producer, so the server can compute lag.
import { context, propagation, trace, SpanKind } from '@opentelemetry/api';
import type { Attributes, Link } from '@opentelemetry/api';
import { enter, inside, settle } from './db.js';

/** Key in job data that carries the producer's trace context (W3C `traceparent`/`tracestate`). */
export const CONTEXT_KEY = '_wt';

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The active context as W3C headers. */
export function headers(): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier;
}

/** Copy of `data` carrying the active context under `_wt`; non-object data is returned unchanged. */
export function injectData(data: unknown): unknown {
  if (data !== undefined && !isPlainObject(data)) return data;
  const carrier = headers();
  return Object.keys(carrier).length ? { ...(data as object), [CONTEXT_KEY]: carrier } : data;
}

/** Remove and return the `_wt` carrier from object job data. */
export function takeContext(data: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(data) || !isPlainObject(data[CONTEXT_KEY])) return undefined;
  const c = data[CONTEXT_KEY] as Record<string, unknown>;
  delete data[CONTEXT_KEY];
  return c;
}

/** A PRODUCER span around `fn`, which gets the headers to send (the producer span's context). */
export function produce<T>(name: string, attributes: Attributes, fn: (h: Record<string, string>) => T): T {
  const parent = context.active();
  if (inside(parent)) return fn(headers());
  const span = trace.getTracer('watchtower').startSpan(name, { kind: SpanKind.PRODUCER, attributes }, parent);
  return settle(span, () => context.with(enter(parent, span), () => fn(headers())));
}

const str = (v: unknown) => (typeof v === 'string' ? v : v instanceof Uint8Array ? Buffer.from(v).toString() : undefined);

/**
 * A CONSUMER span around `fn`, linked to the producer context of each carrier (header maps whose
 * values may be strings or Buffers). With exactly one carrier the producer span is also the parent.
 */
export function consume<T>(name: string, attributes: Attributes, carriers: Array<Record<string, unknown> | undefined>,
  fn: () => T): T {
  let parent = context.active();
  const links: Link[] = [];
  for (const c of carriers) {
    if (!c) continue;
    const tp = str(c.traceparent);
    if (!tp) continue;
    const ts = str(c.tracestate);
    const ctx = propagation.extract(parent, { traceparent: tp, ...(ts ? { tracestate: ts } : {}) });
    const sc = trace.getSpanContext(ctx);
    if (!sc || !trace.isSpanContextValid(sc)) continue;
    links.push({ context: sc });
    if (carriers.length === 1) parent = ctx;
  }
  const span = trace.getTracer('watchtower').startSpan(name, { kind: SpanKind.CONSUMER, attributes, links }, parent);
  return settle(span, () => context.with(enter(parent, span, false), fn));
}
