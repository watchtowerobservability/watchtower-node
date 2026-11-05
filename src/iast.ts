// IAST (opt-in): notices at runtime when request-derived input reaches a sensitive sink and reports
// it to `POST /v1/projects/{prj}/code-security/runtime` (`{service, findings:[{vuln_type, trace_id,
// code_location, severity, title}]}`). Off until `startIast` is called; until then `iastMiddleware`
// is a pass-through and `guardSink` calls the original function untouched.
//
// How: `iastMiddleware()` stores the request's input strings (query, params, body, cookies, header
// values) in an AsyncLocalStorage for the life of the request. `guardSink(fn, vulnType)` wraps a
// sink (`pool.query`, `child_process.exec`, `fs.readFile`, ...); before the call it checks whether
// any input string appears inside the sink's first argument. Parameterised queries keep the input
// in the values array, not the text, so they never match. A hit is queued with the `file:line` of
// the caller (first stack frame outside node_modules and this file) and the active trace id, and
// is flushed in the background. Each (type, location) is reported once per process.
// shortcut: taint is substring matching of raw input values (>= 4 chars) in the sink text, not
// byte-level propagation; input that is transformed (encoded, split) before use is missed.
import { AsyncLocalStorage } from 'node:async_hooks';
import { trace } from '@opentelemetry/api';

export interface IastOptions {
  /** API base URL, e.g. `https://api.example.com`. */
  apiUrl: string;
  apiKey: string;
  project: string;
  service: string;
  fetch?: typeof fetch;
  /** Flush delay in ms (default 2000). */
  flushMs?: number;
}
export interface TaintFinding {
  vuln_type: string;
  trace_id: string;
  code_location: string;
  severity: string;
  title: string;
}

const MIN_LEN = 4;
const MAX_INPUTS = 256;
const store = new AsyncLocalStorage<() => string[]>();
let opts: IastOptions | null = null;
let queue: TaintFinding[] = [];
let seen = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;

export function startIast(o: IastOptions): void {
  opts = o;
}
export function stopIast(): void {
  opts = null;
  queue = [];
  seen = new Set();
  if (timer) clearTimeout(timer);
  timer = null;
}

function collect(v: unknown, out: string[], depth = 0): void {
  if (out.length >= MAX_INPUTS || depth > 4 || v == null) return;
  if (typeof v === 'string') {
    if (v.length >= MIN_LEN) out.push(v);
  } else if (Array.isArray(v)) {
    for (const x of v) collect(x, out, depth + 1);
  } else if (typeof v === 'object') {
    for (const x of Object.values(v as object)) collect(x, out, depth + 1);
  }
}

/** Express/Connect middleware: marks this request's inputs as tainted for downstream sinks. */
export function iastMiddleware() {
  return (req: any, _res: unknown, next: (e?: unknown) => void): void => {
    if (!opts) return next();
    // Resolved at sink time: body parsers and routers run after this middleware.
    const inputsFor = (): string[] => {
      const inputs: string[] = [];
      for (const k of ['query', 'params', 'body', 'cookies', 'headers']) collect(req[k], inputs);
      return inputs;
    };
    store.run(inputsFor, next);
  };
}

function callerLocation(): string {
  const frames = (new Error().stack || '').split('\n').slice(2);
  for (const f of frames) {
    if (f.includes('node_modules') || f.includes('node:internal') || /iast\.[jt]s/.test(f)) continue;
    const m = /\(?([^()\s]+:\d+)(?::\d+)?\)?\s*$/.exec(f);
    if (m) return m[1].replace(/^file:\/\//, '');
  }
  return '';
}

/** Check a sink's text against the current request's inputs; queue a finding on a hit. */
export function checkSink(vulnType: string, text: unknown, severity = 'high'): boolean {
  const inputsFor = store.getStore();
  if (!opts || !inputsFor || typeof text !== 'string') return false;
  if (!inputsFor().some((v) => text.includes(v))) return false;
  const loc = callerLocation();
  const key = `${vulnType}|${loc}`;
  if (seen.has(key)) return true;
  seen.add(key);
  queue.push({
    vuln_type: vulnType,
    trace_id: trace.getActiveSpan()?.spanContext().traceId || '',
    code_location: loc,
    severity,
    title: `Request input reaches ${vulnType.replace(/_/g, ' ')} sink`,
  });
  if (!timer) {
    timer = setTimeout(() => void flushIast(), opts.flushMs ?? 2000);
    timer.unref?.();
  }
  return true;
}

/** Wrap a sink function whose first argument is the sensitive text (SQL, command, path, URL). */
export function guardSink<A extends unknown[], R>(fn: (...a: A) => R, vulnType: string): (...a: A) => R {
  return function (this: unknown, ...a: A): R {
    const first = a[0] as unknown;
    checkSink(vulnType, typeof first === 'string' ? first : (first as { text?: unknown } | null)?.text);
    return fn.apply(this, a);
  };
}

/** Send queued findings now. Never throws; a failed send drops the batch (IAST is best effort). */
export async function flushIast(): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = null;
  const o = opts;
  const findings = queue;
  queue = [];
  if (!o || findings.length === 0) return;
  try {
    await (o.fetch || globalThis.fetch)(
      `${o.apiUrl.replace(/\/$/, '')}/v1/projects/${encodeURIComponent(o.project)}/code-security/runtime`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${o.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ service: o.service, findings }),
      },
    );
  } catch (_e) {
    /* best effort */
  }
}
