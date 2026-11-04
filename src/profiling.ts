// Continuous CPU profiler on V8's own sampler (`node:inspector`, no native addon): every
// `periodMs` the CPU profile is folded into stacks, encoded as pprof and posted to the gateway's
// `/v1/profiles?format=pprof` with `service` and `version`. Best effort: a failed upload is
// counted and dropped. `withSpan` labels samples taken while its function runs, joined
// on V8's sample timestamps, so a trace links to its exact profile.
import { AsyncLocalStorage } from 'node:async_hooks';
import { Session } from 'node:inspector';
import { promiseHooks } from 'node:v8';
import { trace } from '@opentelemetry/api';
import { foldedToPprof } from './pprof.js';

export interface CallFrame {
  functionName: string;
  url: string;
  lineNumber: number;
}
export interface CpuProfileNode {
  id: number;
  callFrame: CallFrame;
  children?: number[];
}
export interface CpuProfile {
  nodes: CpuProfileNode[];
  samples?: number[];
  /** Microseconds on the monotonic clock. */
  startTime?: number;
  timeDeltas?: number[];
}

/** A span's time on the JS thread, microseconds on the same clock as the profile. */
export interface SpanInterval {
  start: number;
  end: number;
  prefix: string;
}

const intervals: SpanInterval[] = [];
const MAX_INTERVALS = 100_000;

function nowUs(): number {
  return Number(process.hrtime.bigint() / 1000n);
}

/** The span of the running code, carried across `await` once async labels are on. */
const spanStore = new AsyncLocalStorage<string>();
/** Promises created under a span, and that span. */
const tagged = new WeakMap<Promise<unknown>, string>();
/** The interval each `before` opened, for its `after`; `null` for an unlabeled continuation. */
const running: (SpanInterval | null)[] = [];
let asyncSpans = false;

function open(prefix: string): SpanInterval | null {
  if (intervals.length >= MAX_INTERVALS) return null;
  const iv = { start: nowUs(), end: Number.MAX_SAFE_INTEGER, prefix };
  intervals.push(iv);
  return iv;
}

/**
 * Opt-in (overhead unmeasured): `withSpan` also labels its async function's code after each
 * `await`. The span rides in an AsyncLocalStorage; a promise created under it is tagged, and each
 * run of its continuation (V8 promise hooks `before` to `after`) is one more interval. Plain
 * callbacks it starts (timers, events) are labeled only from their own `await`s on.
 */
export function enableAsyncSpanLabels(): void {
  if (asyncSpans) return;
  asyncSpans = true;
  promiseHooks.createHook({
    init(promise) {
      const p = spanStore.getStore(); // init runs synchronously, in the creating code's context
      if (p) tagged.set(promise, p);
    },
    before(promise) {
      if (running.length >= 1_000) running.length = 0; // afters lost to an uncaught exception
      const p = tagged.get(promise);
      running.push(p ? open(p) : null);
    },
    after() {
      const iv = running.pop();
      if (iv) iv.end = nowUs();
    },
  });
}

/**
 * Labels samples taken while `fn` runs with a span (default: the active OpenTelemetry span). Only
 * `fn`'s synchronous part, unless [[enableAsyncSpanLabels]] (or the profiler's `asyncSpans`) is on.
 */
export function withSpan<T>(fn: () => T, ids?: { spanId: string; traceId: string }): T {
  const sc = ids ?? trace.getActiveSpan()?.spanContext();
  if (!sc || intervals.length >= MAX_INTERVALS) return fn();
  const prefix = `span_id=${sc.spanId},trace_id=${sc.traceId}\t`;
  const iv = open(prefix)!;
  try {
    return asyncSpans ? spanStore.run(prefix, fn) : fn();
  } finally {
    iv.end = nowUs();
  }
}

/** Takes the intervals a profile up to `until` can need; open ones stay for the next profile. */
export function takeIntervals(until: number): SpanInterval[] {
  const out = intervals.slice();
  const keep = out.filter((iv) => iv.end > until);
  intervals.length = 0;
  intervals.push(...keep);
  return out;
}

/** The innermost span at `t`; `sorted` is by start. */
function prefixAt(sorted: SpanInterval[], t: number): string {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid].start <= t) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo - 1; i >= 0 && i >= lo - 16; i--) if (sorted[i].end >= t) return sorted[i].prefix;
  return '';
}

export interface ProfilerOptions {
  /** Ingest key; defaults to WT_INGEST_KEY. */
  apiKey?: string;
  /** Gateway base URL; defaults to WT_OTLP_ENDPOINT or http://localhost:4318. */
  endpoint?: string;
  /** Defaults to WT_SERVICE or `app`. */
  service?: string;
  tags?: Record<string, string | undefined>;
  /** Sampling interval in microseconds (default 10 000 = 100 Hz). */
  intervalUs?: number;
  /** Upload period (default 60 000 ms). */
  periodMs?: number;
  /** Label `withSpan` code after `await` too (see [[enableAsyncSpanLabels]]). Default false. */
  asyncSpans?: boolean;
}

const MAX_DEPTH = 128;

function frameName(f: CallFrame): string {
  const file = f.url ? f.url.split('/').pop() : '';
  const name = f.functionName || '(anonymous)';
  return (file ? `${name} (${file}:${f.lineNumber + 1})` : name).replace(/;/g, ':');
}

/** Root-first folded stacks with their sample counts; V8's synthetic `(root)` is left out. */
export function foldProfile(p: CpuProfile, spans: SpanInterval[] = []): Map<string, number> {
  const parent = new Map<number, number>();
  const byId = new Map<number, CpuProfileNode>();
  for (const n of p.nodes) {
    byId.set(n.id, n);
    for (const c of n.children ?? []) parent.set(c, n.id);
  }
  const counts = new Map<string, number>();
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  let t = p.startTime ?? 0;
  for (const [i, id] of (p.samples ?? []).entries()) {
    t += p.timeDeltas?.[i] ?? 0;
    const names: string[] = [];
    for (let cur: number | undefined = id; cur !== undefined && names.length < MAX_DEPTH; cur = parent.get(cur)) {
      const n = byId.get(cur);
      if (!n || n.callFrame.functionName === '(root)') break;
      if (n.callFrame.functionName === '(idle)' || n.callFrame.functionName === '(program)') {
        names.length = 0;
        break;
      }
      names.push(frameName(n.callFrame));
    }
    if (names.length === 0) continue;
    const key = prefixAt(sorted, t) + names.reverse().join(';');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export function foldedBody(counts: Map<string, number>): string {
  let out = '';
  for (const [k, n] of counts) out += `${k} ${n}\n`;
  return out;
}

/** `/v1/profiles?format=pprof&service=…&version=…` on the gateway. */
export function profilesUrl(endpoint: string, service: string, version?: string): string {
  const q = new URLSearchParams({ format: 'pprof', service });
  if (version) q.set('version', version);
  return `${endpoint.replace(/\/+$/, '')}/v1/profiles?${q}`;
}

/** Pyroscope-compatible `/ingest` URL for folded uploads (kept for callers; the Profiler sends pprof). */
export function ingestUrl(endpoint: string, service: string, tags: Record<string, string | undefined>,
  fromS: number, untilS: number, hz: number): string {
  const labels = Object.entries(tags).filter(([, v]) => v).sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`).join(',');
  const q = new URLSearchParams({
    name: `${service}.cpu{${labels}}`, from: String(Math.floor(fromS)), until: String(Math.floor(untilS)),
    format: 'folded', sampleRate: String(hz), spyName: 'watchtower-node', units: 'samples',
  });
  return `${endpoint.replace(/\/+$/, '')}/ingest?${q}`;
}

export class Profiler {
  uploaded = 0;
  dropped = 0;
  private readonly key: string;
  private readonly endpoint: string;
  private readonly service: string;
  private readonly tags: Record<string, string | undefined>;
  private readonly intervalUs: number;
  private readonly periodMs: number;
  private session?: Session;
  private timer?: NodeJS.Timeout;
  private from = 0;

  constructor(o: ProfilerOptions = {}) {
    const key = o.apiKey ?? process.env.WT_INGEST_KEY;
    if (!key) throw new Error('apiKey is required');
    this.key = key;
    this.endpoint = o.endpoint ?? process.env.WT_OTLP_ENDPOINT ?? 'http://localhost:4318';
    this.service = o.service ?? process.env.WT_SERVICE ?? 'app';
    this.tags = { env: process.env.WT_ENVIRONMENT, version: process.env.WT_RELEASE, ...o.tags };
    this.intervalUs = Math.min(Math.max(o.intervalUs ?? 10_000, 1_000), 1_000_000);
    this.periodMs = Math.max(o.periodMs ?? 60_000, 1_000);
    if (o.asyncSpans) enableAsyncSpanLabels();
  }

  /** Not printable with the key. */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `Profiler { service: '${this.service}' }`;
  }

  private post<T>(method: string, params?: object): Promise<T> {
    return new Promise((resolve, reject) => {
      this.session!.post(method, params ?? {}, (err, res) => (err ? reject(err) : resolve(res as T)));
    });
  }

  async start(): Promise<this> {
    if (this.session) return this;
    this.session = new Session();
    this.session.connect();
    await this.post('Profiler.enable');
    await this.post('Profiler.setSamplingInterval', { interval: this.intervalUs });
    await this.post('Profiler.start');
    this.from = Date.now() / 1000;
    this.timer = setInterval(() => void this.flush(true), this.periodMs);
    this.timer.unref();
    return this;
  }

  /** Stop the current profile, upload it and (when `restart`) start the next one. */
  async flush(restart: boolean): Promise<void> {
    if (!this.session) return;
    const until = Date.now() / 1000;
    const { profile } = await this.post<{ profile: CpuProfile }>('Profiler.stop');
    const from = this.from;
    if (restart) {
      await this.post('Profiler.start');
      this.from = until;
    }
    const counts = foldProfile(profile, takeIntervals(nowUs()));
    if (counts.size) await this.upload(counts, from, until);
  }

  async upload(counts: Map<string, number>, fromS: number, untilS: number): Promise<void> {
    try {
      const body = foldedToPprof(counts, this.intervalUs * 1000, fromS * 1000, (untilS - fromS) * 1000);
      const r = await fetch(profilesUrl(this.endpoint, this.service, this.tags.version), {
        method: 'POST', body,
        headers: { authorization: `Bearer ${this.key}`, 'content-type': 'application/octet-stream' },
        signal: AbortSignal.timeout(10_000),
      });
      if (r.ok) this.uploaded++;
      else this.dropped++;
    } catch {
      this.dropped++;
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.flush(false).catch(() => undefined);
    this.session?.disconnect();
    this.session = undefined;
  }
}

/** Start a [[Profiler]] with the SDK's environment defaults. */
export function startProfiling(o: ProfilerOptions = {}): Promise<Profiler> {
  return new Profiler(o).start();
}
