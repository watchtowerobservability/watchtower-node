// Shared core for the datastore and queue integrations: CLIENT spans with OTel db semconv, the
// statement hash and N+1 hint, connection-pool metrics and embedded-store gauges.
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { context, createContextKey, metrics, trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { Attributes, BatchObservableResult, Context, Counter, Histogram, Meter, Span, TimeInput } from '@opentelemetry/api';
import { isPgDialect, normalizeAndHash, querySummary } from '../sql.js';

export interface DbOptions {
  /** Add the literal-free statement as `db.query.text`. Default: `WATCHTOWER_DB_QUERY_TEXT=1`. */
  queryText?: boolean;
  /** Flag a statement run more than this many times under one parent span. Default:
   * `WATCHTOWER_DB_N_PLUS_ONE` or 5; 0 turns it off. */
  nPlusOne?: number;
}

export interface DbOp {
  /** `db.system.name`, e.g. `sqlite`. */
  system: string;
  operation?: string;
  collection?: string;
  namespace?: string;
  /** Statement text: summarised and hashed, never recorded raw. */
  sql?: string | null;
  attributes?: Attributes;
}

/** Set inside an instrumented call so a wrapper the library calls internally adds no second span. */
const INSIDE = createContextKey('watchtower.db.inside');
export const inside = (ctx: Context = context.active()) => ctx.getValue(INSIDE) === true;
/** `parent` with `span` active; `nested` marks it as inside an instrumented call (no inner spans). */
export const enter = (parent: Context, span: Span, nested = true): Context =>
  nested ? trace.setSpan(parent, span).setValue(INSIDE, true) : trace.setSpan(parent, span).deleteValue(INSIDE);

const on = (v: string | undefined) => ['1', 'true', 'on', 'yes'].includes((v || '').trim().toLowerCase());
const threshold = (o?: DbOptions) => o?.nPlusOne ?? (Number(process.env.WATCHTOWER_DB_N_PLUS_ONE) || 5);

// parent span id -> statement key -> count.
// shortcut: keeps the 1000 most recently seen parents; raise it if very wide fan-out traces miss hints.
const seen = new Map<string, Map<string, number>>();
function repeats(parent: string, key: string): number {
  let m = seen.get(parent);
  if (!m) {
    if (seen.size >= 1000) seen.delete(seen.keys().next().value!);
    seen.set(parent, (m = new Map()));
  }
  const n = (m.get(key) ?? 0) + 1;
  m.set(key, n);
  return n;
}

/** A CLIENT span for `op` (not made active): summary, hash, N+1 hint. Prefer `traced`. */
export function startDbSpan(op: DbOp, opts: DbOptions | undefined, parent: Context, startTime?: TimeInput): Span {
  const attrs: Attributes = { 'db.system.name': op.system, ...op.attributes };
  let { operation, collection } = op;
  let name = [operation, collection].filter(Boolean).join(' ') || op.system;
  let key = name;
  if (op.sql) {
    const [norm, hash] = normalizeAndHash(op.sql, isPgDialect(op.system));
    const s = querySummary(norm, op.system);
    operation ??= s.operation;
    collection ??= s.target;
    name = s.summary;
    key = hash;
    attrs['db.query.summary'] = s.summary;
    attrs['db.query.hash'] = hash;
    if (opts?.queryText ?? on(process.env.WATCHTOWER_DB_QUERY_TEXT)) attrs['db.query.text'] = norm;
  }
  if (operation) attrs['db.operation.name'] = operation;
  if (collection) attrs['db.collection.name'] = collection;
  if (op.namespace) attrs['db.namespace'] = op.namespace;
  const p = trace.getSpan(parent)?.spanContext();
  const max = threshold(opts);
  if (p && max > 0) {
    const n = repeats(p.spanId, key);
    if (n > max) {
      attrs['db.query.repeat_count'] = n;
      attrs['db.n_plus_one'] = true;
    }
  }
  return trace.getTracer('watchtower').startSpan(name, { kind: SpanKind.CLIENT, attributes: attrs, startTime }, parent);
}

/** A finished CLIENT span for a query a library reports after the fact (ORM loggers): it ends now. */
export function recordDbSpan(op: DbOp, opts: DbOptions | undefined, durationMs: number, error?: unknown): void {
  const end = Date.now();
  const span = startDbSpan(op, opts, context.active(), end - Math.max(0, durationMs || 0));
  if (error) fail(span, error);
  span.end(end);
}

/** Error status with the driver's code; the message is not recorded (it can quote values). */
export function fail(span: Span, e: unknown): void {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === 'string' || typeof code === 'number') {
    span.setAttribute('db.response.status_code', String(code));
    span.setAttribute('error.type', String(code));
  } else {
    span.setAttribute('error.type', (e as Error | null)?.name || 'Error');
  }
  span.setStatus({ code: SpanStatusCode.ERROR });
}

const isThenable = (v: unknown): v is PromiseLike<unknown> =>
  !!v && (typeof v === 'object' || typeof v === 'function') && typeof (v as PromiseLike<unknown>).then === 'function';

/** Run `fn` and end `span` when it returns, throws or its promise settles. The result is returned as is. */
export function settle<T>(span: Span, fn: () => T): T {
  let r: T;
  try {
    r = fn();
  } catch (e) {
    fail(span, e);
    span.end();
    throw e;
  }
  if (isThenable(r)) {
    r.then(() => span.end(), (e) => { fail(span, e); span.end(); });
  } else {
    span.end();
  }
  return r;
}

/** A CLIENT span around `fn` (sync or promise), child of the active span. `nested: false` lets
 * calls made inside `fn` (a transaction callback) get their own spans. */
export function traced<T>(op: DbOp, opts: DbOptions | undefined, fn: () => T, nested = true): T {
  const parent = context.active();
  if (inside(parent)) return fn();
  const span = startDbSpan(op, opts, parent);
  return settle(span, () => context.with(enter(parent, span, nested), fn));
}

/** `traced` for node-style callback APIs: the last function argument ends the span and runs in the caller's context. */
export function tracedCb<T>(op: DbOp, opts: DbOptions | undefined, args: unknown[], call: (args: unknown[]) => T): T {
  const last = args.length - 1;
  const cb = args[last];
  const parent = context.active();
  if (typeof cb !== 'function') return traced(op, opts, () => call(args));
  if (inside(parent)) return call(args);
  const span = startDbSpan(op, opts, parent);
  const copy = args.slice();
  copy[last] = context.bind(parent, function (this: unknown, err: unknown, ...rest: unknown[]) {
    if (err) fail(span, err);
    span.end();
    return (cb as (...a: unknown[]) => unknown).apply(this, [err, ...rest]);
  });
  try {
    return context.with(enter(parent, span), () => call(copy));
  } catch (e) {
    fail(span, e);
    span.end();
    throw e;
  }
}

/** Wrap `obj[name]` once; `wrap` gets the original. Missing methods are skipped. */
export function patch<T extends object>(obj: T, name: string, wrap: (orig: (...a: any[]) => any) => (...a: any[]) => any): void {
  const o = obj as Record<string | symbol, any>;
  const orig = o[name];
  if (typeof orig !== 'function' || orig[WRAPPED]) return;
  const w = wrap(orig);
  (w as any)[WRAPPED] = true;
  o[name] = w;
}
const WRAPPED = Symbol.for('watchtower.wrapped');

// ---- metrics (instruments come from the global meter: call the observe* helpers after init) ----
const meter = (): Meter => metrics.getMeter('watchtower');
let cached: { m: Meter; wait: Histogram; use: Histogram; timeouts: Counter; hits: Counter; misses: Counter } | undefined;
function inst() {
  const m = meter();
  if (cached?.m !== m) {
    cached = {
      m,
      wait: m.createHistogram('db.client.connection.wait_time', { unit: 's' }),
      use: m.createHistogram('db.client.connection.use_time', { unit: 's' }),
      timeouts: m.createCounter('db.client.connection.timeouts'),
      hits: m.createCounter('wt.embedded.cache.hits'),
      misses: m.createCounter('wt.embedded.cache.misses'),
    };
  }
  return cached;
}

export interface PoolState { used?: number; idle?: number; pending?: number; max?: number }

/**
 * Pool gauges per OTel db semconv, read at each export: `db.client.connection.count{state}`,
 * `.max`, `.pending_requests`, with `db.client.connection.pool.name` and `db.system.name`.
 * Returns the recorders for wait/use time and timeouts, and `stop()`.
 */
export function observePool(system: string, pool: string, read: () => PoolState) {
  const attrs = { 'db.system.name': system, 'db.client.connection.pool.name': pool };
  const m = meter();
  const count = m.createObservableGauge('db.client.connection.count');
  const max = m.createObservableGauge('db.client.connection.max');
  const pending = m.createObservableGauge('db.client.connection.pending_requests');
  const cb = (r: BatchObservableResult) => {
    const s = read();
    if (s.used !== undefined) r.observe(count, s.used, { ...attrs, 'db.client.connection.state': 'used' });
    if (s.idle !== undefined) r.observe(count, s.idle, { ...attrs, 'db.client.connection.state': 'idle' });
    if (s.max !== undefined) r.observe(max, s.max, attrs);
    if (s.pending !== undefined) r.observe(pending, s.pending, attrs);
  };
  m.addBatchObservableCallback(cb, [count, max, pending]);
  return {
    wait: (seconds: number) => inst().wait.record(seconds, attrs),
    use: (seconds: number) => inst().use.record(seconds, attrs),
    timeout: () => inst().timeouts.add(1, attrs),
    stop: () => m.removeBatchObservableCallback(cb, [count, max, pending]),
  };
}

/** `wt.embedded.<key>` gauges for an embedded store, read at each export. Returns `stop()`. */
export function observeEmbedded(system: string, namespace: string | undefined, keys: string[],
  read: () => Partial<Record<string, number>>): () => void {
  const attrs: Attributes = { 'db.system.name': system, ...(namespace ? { 'db.namespace': namespace } : {}) };
  const m = meter();
  const gauges = keys.map((k) => [k, m.createObservableGauge(`wt.embedded.${k}`)] as const);
  const cb = (r: BatchObservableResult) => {
    let v: Partial<Record<string, number>>;
    try { v = read(); } catch { return; }
    for (const [k, g] of gauges) if (typeof v[k] === 'number') r.observe(g, v[k]!, attrs);
  };
  m.addBatchObservableCallback(cb, gauges.map(([, g]) => g));
  return () => m.removeBatchObservableCallback(cb, gauges.map(([, g]) => g));
}

/** Hit/miss counters (`wt.embedded.cache.hits` / `.misses`) for an in-memory cache. */
export function cacheCounters(system: string, name: string) {
  const attrs = { 'db.system.name': system, 'db.namespace': name };
  return { hit: (n = 1) => inst().hits.add(n, attrs), miss: (n = 1) => inst().misses.add(n, attrs) };
}

/** Size in bytes of a file, or of the files directly in a directory; 0 when missing. */
export function sizeOf(path: string): number {
  try {
    const st = fs.statSync(path);
    if (!st.isDirectory()) return st.size;
    return fs.readdirSync(path).reduce((n, f) => {
      try { return n + fs.statSync(nodePath.join(path, f)).size; } catch { return n; }
    }, 0);
  } catch {
    return 0;
  }
}
