// Dynamic probes for running Node.js code (PLT-044), with the safety model of the Python, Go and
// browser agents: off until `startProbes` is called, read-only and bounded.
//
// A worker thread connects the inspector to the main thread and sets a breakpoint per live probe
// (`file` + `line`). On a hit it reads the frame's local scopes with `Runtime.getProperties`
// (own data properties only: getters, proxies' traps and user methods never run; depth at most 3,
// 50 properties per object) and resumes at once. The main thread then evaluates the probe's
// condition (a subset with no calls) over those plain values, applies the per-minute rate
// limit, flattens them to `code.snapshot.*` (8 KiB, 1 KiB per value) and emits `probe.snapshot`.
// With no live probe the debugger is disabled and nothing pauses.
//
// Kind `span` wraps a CommonJS export named by `location.function` (`src/billing.js:charge`,
// `Billing.prototype.charge` or a bare export name) in a current span `probe <fn>`; removing the
// probe restores the original. Kind `span_decoration` at `file` + `line` sets `capture.tags`
// (templates over the locals) on the span active in the paused frame, through one fixed
// expression of ours evaluated on that frame (it reads the OpenTelemetry API global and calls
// `setAttributes` with JSON literals; no user code is called). At `function` it tags at entry.
// shortcut: ES module namespaces are read-only, so span probes reach CommonJS exports only;
// upgrade with a loader hook (`module.register`) when ESM apps need them.
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { context, SpanStatusCode, trace } from '@opentelemetry/api';

export type Vars = Record<string, unknown>;

export interface ProbeDef {
  id: string;
  kind?: string;
  location: { file?: string; line?: number; function?: string };
  condition?: string;
  message?: string;
  capture?: { locals_depth?: number; max_bytes?: number; tags?: { name: string; value: string }[] };
  max_rate_per_min?: number;
  expires_at?: number;
}

export interface ProbesOptions {
  /** API base; default `WT_API_URL` or https://api.watchtower.dev */
  endpoint?: string;
  /** ingestion key with scope `probes:read`; default `WT_INGEST_KEY` */
  key?: string;
  service?: string;
  env?: string;
  version?: string;
  intervalMs?: number;
  /** where snapshots go; default: a log record on `logger` when given */
  emit?: (name: string, attrs: Record<string, string>) => void;
  logger?: { emit(rec: { body: string; attributes: Record<string, string> }): void };
  now?: () => number;
  fetch?: typeof fetch;
}

const VALUE_MAX = 1024;
/** Collected pauses per probe and minute; beyond it the worker resumes without reading locals. */
const MAX_PAUSES_PER_MIN = 600;

type Node = (v: Vars) => unknown;

/** Compile a condition; throws on anything outside the subset (calls included). Self-contained: the worker embeds its source. */
export function compile(src = ''): (v: Vars) => boolean {
  if (!src.trim()) return () => true;
  const TOKEN = /\s*(&&|\|\||==|!=|<=|>=|[<>!()[\],]|'[^']*'|"[^"]*"|-?\d+(?:\.\d+)?|[A-Za-z_][\w.]*)/y;
  const t: string[] = [];
  TOKEN.lastIndex = 0;
  let end = 0;
  for (let m: RegExpExecArray | null; (m = TOKEN.exec(src)); end = TOKEN.lastIndex) t.push(m[1]!);
  if (end !== src.trimEnd().length) throw new Error('bad condition');
  let i = 0;
  const eat = (s: string): boolean => (t[i] === s ? (i++, true) : false);
  const get = (v: Vars, name: string): unknown =>
    name.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Vars)[k] : undefined), v);
  const lit = (x: string): unknown =>
    x === 'true' ? true : x === 'false' ? false : x === 'null' ? null : /^['"]/.test(x) ? x.slice(1, -1) : Number(x);
  const atom = (): Node => {
    const x = t[i++];
    if (x === undefined) throw new Error('bad condition');
    if (x === '(') {
      const e = or();
      if (!eat(')')) throw new Error('bad condition');
      return e;
    }
    if (x === '[') {
      const items: unknown[] = [];
      while (t[i] !== ']') {
        if (i >= t.length) throw new Error('bad condition');
        const n = t[i++]!;
        if (n !== ',') items.push(lit(n));
      }
      i++;
      return () => items;
    }
    if (/^['"]|^-?\d/.test(x) || x === 'true' || x === 'false' || x === 'null') {
      const val = lit(x);
      return () => val;
    }
    if (t[i] === '(') throw new Error('function calls are not allowed');
    return (v) => get(v, x);
  };
  const cmp = (): Node => {
    const a = atom();
    for (const op of ['==', '!=', '<=', '>=', '<', '>', 'in', 'contains']) {
      if (!eat(op)) continue;
      const b = atom();
      return (v) => {
        const x = a(v) as never, y = b(v) as never;
        switch (op) {
          case '==': return x === y;
          case '!=': return x !== y;
          case '<': return x < y;
          case '<=': return x <= y;
          case '>': return x > y;
          case '>=': return x >= y;
          case 'in': return Array.isArray(y) && (y as unknown[]).includes(x);
          default: return typeof x === 'string' && typeof y === 'string' && (x as string).includes(y as string);
        }
      };
    }
    return a;
  };
  const not = (): Node => {
    if (eat('!')) {
      const n = not();
      return (v) => !n(v);
    }
    return cmp();
  };
  const and = (): Node => {
    let l = not();
    while (eat('&&')) { const a = l, r = not(); l = (v) => !!a(v) && !!r(v); }
    return l;
  };
  const or = (): Node => {
    let l = and();
    while (eat('||')) { const a = l, r = and(); l = (v) => !!a(v) || !!r(v); }
    return l;
  };
  const root = or();
  if (i !== t.length) throw new Error('bad condition');
  return (v) => !!root(v);
}

/** Flatten to dotted names: nesting past `depth` collapses, values cut to 1 KiB, total to `maxBytes`. */
export function capture(vars: Vars, depth: number, maxBytes: number): Record<string, string> {
  const out: Record<string, string> = {};
  let used = 0;
  const put = (name: string, val: string): void => {
    const s = val.slice(0, VALUE_MAX);
    if (used + name.length + s.length <= maxBytes) {
      used += name.length + s.length;
      out[name] = s;
    }
  };
  const walk = (prefix: string, v: unknown, d: number): void => {
    if (v && typeof v === 'object') {
      if (d > depth) return put(prefix, '[depth limit]');
      for (const k of Object.keys(v).sort()) walk(prefix ? `${prefix}.${k}` : k, (v as Vars)[k], d + 1);
    } else put(prefix, String(v));
  };
  walk('', vars, 0);
  return out;
}

/** Fill `{a.b}` from vars (missing names render empty), cut to 1 KiB. Self-contained: the worker embeds it. */
export function render(template: string, vars: Vars): string {
  return template.replace(/\{([A-Za-z_][\w.]*)\}/g, (_m, name: string) => {
    const v = name.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Vars)[k] : undefined), vars);
    return v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  }).slice(0, 1024);
}

/** `capture.tags` rendered over vars; `wt.*` names are never set. */
export function tags(def: ProbeDef, vars: Vars): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of def.capture?.tags ?? []) if (t.name && !t.name.startsWith('wt.')) out[t.name] = render(t.value ?? '', vars);
  return out;
}

/** The expression the worker evaluates on a paused frame: tag the active span (OTel API 1.x global). */
export function decorateExpr(attrs: Record<string, string>): string {
  return `(() => { const g = globalThis[Symbol.for('opentelemetry.js.api.1')]; ` +
    `const s = g && g.context && g.context.active().getValue(Symbol.for('OpenTelemetry Context Key SPAN')); ` +
    `if (s && s.isRecording()) s.setAttributes(${JSON.stringify(attrs)}); })()`;
}

// The worker: inspector bridge; decorations are judged here because the main thread is paused.
const WORKER = `
const compile = ${compile.toString()};
const render = ${render.toString()};
const decorateExpr = ${decorateExpr.toString()};
const { parentPort } = require('node:worker_threads');
const { Session } = require('node:inspector');
const s = new Session();
s.connectToMainThread();
const post = (m, p) => new Promise((ok, no) => s.post(m, p || {}, (e, r) => (e ? no(e) : ok(r))));
let enabled = false, byBp = new Map(), counts = new Map(), win = 0, decs = new Map();
const MAX = ${MAX_PAUSES_PER_MIN};
async function plain(objectId, d) {
  const { result } = await post('Runtime.getProperties', { objectId, ownProperties: true, generatePreview: false });
  const out = {};
  for (const p of result.slice(0, 50)) {
    const v = p.value;
    if (!v || v.type === 'function' || v.type === 'symbol') continue; // accessors stay unread
    if (v.type === 'object' && v.subtype !== 'null') out[p.name] = d >= 3 ? '[depth limit]' : await plain(v.objectId, d + 1);
    else out[p.name] = v.subtype === 'null' ? null : v.type === 'undefined' ? 'undefined' : v.unserializableValue ?? v.value;
  }
  return out;
}
s.on('Debugger.paused', async ({ params }) => {
  try {
    const all = (params.hitBreakpoints || []).map((b) => byBp.get(b)).filter(Boolean);
    const now = Date.now(), minute = Math.floor(now / 60000);
    if (minute !== win) { win = minute; counts = new Map(); }
    const take = all.filter((id) => { const n = (counts.get(id) || 0) + 1; counts.set(id, n); return n <= (decs.has(id) ? Math.min(decs.get(id).rate || 60, 60) : MAX); });
    if (!take.length) return;
    const f = params.callFrames[0];
    const vars = {};
    for (const sc of f.scopeChain) if (sc.type === 'local' || sc.type === 'block') Object.assign(vars, await plain(sc.object.objectId, 1));
    for (const id of take.filter((i) => decs.has(i))) {
      const d = decs.get(id);
      if ((d.exp && now >= d.exp) || !d.ok(vars)) continue;
      const attrs = {};
      for (const t of d.tags) if (t.name && !t.name.startsWith('wt.')) attrs[t.name] = render(t.value || '', vars);
      await post('Debugger.evaluateOnCallFrame', { callFrameId: f.callFrameId, expression: decorateExpr(attrs), silent: true });
    }
    const ids = take.filter((i) => !decs.has(i));
    if (ids.length) parentPort.postMessage({ ids, fn: f.functionName, url: f.url, line: f.location.lineNumber + 1, vars });
  } catch {} finally { s.post('Debugger.resume'); }
});
parentPort.on('message', async (defs) => {
  try {
    for (const bp of byBp.keys()) await post('Debugger.removeBreakpoint', { breakpointId: bp });
    byBp = new Map();
    decs = new Map();
    for (const d of defs) if (d.dec) { try { decs.set(d.id, { ...d.dec, ok: compile(d.dec.cond) }); } catch {} }
    if (!defs.length) { if (enabled) await post('Debugger.disable'); enabled = false; return; }
    if (!enabled) { await post('Debugger.enable'); enabled = true; }
    for (const d of defs) {
      const r = await post('Debugger.setBreakpointByUrl', { lineNumber: d.line - 1, urlRegex: d.urlRegex });
      byBp.set(r.breakpointId, d.id);
    }
  } catch {}
});
`;

interface Live { def: ProbeDef; ok: (v: Vars) => boolean; win: number; n: number }
type Bp = { id: string; line: number; urlRegex: string; dec?: { cond: string; tags: { name: string; value: string }[]; rate: number; exp: number } };
type Wrap = { holder: Record<string, unknown>; key: string; orig: unknown };

/** Parameter names of a function from its source (`argN` where a parameter is destructured or unknown). */
export function paramNames(fn: Function): string[] {
  const m = /^[^(]*\(([^)]*)\)/.exec(Function.prototype.toString.call(fn)) ?? /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>/.exec(Function.prototype.toString.call(fn));
  return (m?.[1] ?? '').split(',').map((p, i) => /^\s*(?:\.\.\.)?([A-Za-z_$][\w$]*)\s*(=.*)?$/.exec(p)?.[1] ?? `arg${i}`);
}

/** The object holding `path` (dots) in a module's exports, or null. */
function locate(exports: unknown, path: string): { holder: Record<string, unknown>; key: string } | null {
  const parts = path.split('.');
  let holder = exports as Record<string, unknown> | undefined;
  for (const k of parts.slice(0, -1)) holder = holder && (typeof holder === 'object' || typeof holder === 'function') ? (holder[k] as Record<string, unknown>) : undefined;
  const key = parts[parts.length - 1]!;
  if (!holder || (typeof holder !== 'object' && typeof holder !== 'function')) return null;
  const desc = Object.getOwnPropertyDescriptor(holder, key);
  return desc && desc.writable && typeof desc.value === 'function' ? { holder, key } : null;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The probe set of one service: `set` replaces it, `poll` refreshes it, `onHit` handles a pause. */
export function createProbes(o: ProbesOptions & { post?: (defs: Bp[]) => void; modules?: () => Record<string, { exports: unknown } | undefined> }) {
  const now = o.now ?? Date.now;
  const emit = o.emit ?? ((name: string, attrs: Record<string, string>) => o.logger?.emit({ body: name, attributes: attrs }));
  const endpoint = (o.endpoint ?? process.env.WT_API_URL ?? 'https://api.watchtower.dev').replace(/\/+$/, '');
  const modules = o.modules ?? (() => createRequire(`${process.cwd()}/`).cache);
  let live = new Map<string, Live>();
  let wraps: Wrap[] = [];
  let etag = '';
  /** Not expired (expires_at is unix seconds), inside the per-minute budget, condition holds; counts the hit. */
  const allowed = (p: Live, vars: Vars): boolean => {
    const t = now();
    if (p.def.expires_at && t >= p.def.expires_at * 1000) return false;
    const minute = Math.floor(t / 60000);
    if (p.win !== minute) { p.win = minute; p.n = 0; }
    if (p.n >= Math.min(p.def.max_rate_per_min || 60, 60) || !p.ok(vars)) return false;
    p.n++;
    return true;
  };
  const wrap = (p: Live, holder: Record<string, unknown>, key: string): void => {
    const orig = holder[key] as (...a: unknown[]) => unknown;
    const names = paramNames(orig);
    const fnName = p.def.location.function!;
    const wrapped = function (this: unknown, ...args: unknown[]): unknown {
      const vars: Vars = {};
      args.forEach((a, i) => { vars[names[i] ?? `arg${i}`] = a; });
      if (!allowed(p, vars)) return orig.apply(this, args);
      if (p.def.kind === 'span_decoration') {
        try { trace.getActiveSpan()?.setAttributes(tags(p.def, vars)); } catch { /* never fail the app */ }
        return orig.apply(this, args);
      }
      const span = trace.getTracer('watchtower.probes').startSpan(`probe ${key}`, {
        attributes: { 'probe.id': p.def.id, 'code.function': fnName },
      });
      const fail = (e: unknown): void => {
        span.recordException(e instanceof Error ? e : String(e));
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.end();
      };
      return context.with(trace.setSpan(context.active(), span), () => {
        let r: unknown;
        try { r = orig.apply(this, args); } catch (e) { fail(e); throw e; }
        if (r && typeof (r as Promise<unknown>).then === 'function') {
          return (r as Promise<unknown>).then((v) => { span.end(); return v; }, (e: unknown) => { fail(e); throw e; });
        }
        span.end();
        return r;
      });
    };
    Object.defineProperty(wrapped, 'name', { value: orig.name });
    holder[key] = wrapped;
    wraps.push({ holder, key, orig });
  };
  /** Wrap `file.js:path` (or `path` in any app module) for span and function-located decoration probes. */
  const attach = (p: Live): boolean => {
    const fn = p.def.location.function ?? '';
    const at = fn.lastIndexOf(':');
    const [file, path] = at > 0 ? [fn.slice(0, at), fn.slice(at + 1)] : ['', fn];
    let hit = false;
    for (const [filename, m] of Object.entries(modules())) {
      if (!m || (file ? !filename.endsWith(file.replace(/^\/+/, '')) : filename.includes('/node_modules/'))) continue;
      const loc = locate(m.exports, path);
      if (loc) { wrap(p, loc.holder, loc.key); hit = true; }
    }
    return hit;
  };
  const set = (defs: ProbeDef[]): void => {
    for (const w of wraps.reverse()) w.holder[w.key] = w.orig;
    wraps = [];
    const next = new Map<string, Live>();
    const bps: Bp[] = [];
    for (const d of defs) {
      try {
        const p: Live = { def: d, ok: compile(d.condition), win: 0, n: 0 };
        const fnProbe = d.kind === 'span' || (d.kind === 'span_decoration' && !d.location.line);
        if (fnProbe) {
          if (d.location.function && attach(p)) next.set(d.id, p);
          continue;
        }
        // shortcut: other Node probes need file + line (the source view always sends both).
        if (!d.location.file || !d.location.line) continue;
        next.set(d.id, p);
        const bp: Bp = { id: d.id, line: d.location.line, urlRegex: `(^|/)${escapeRe(d.location.file.replace(/^\/+/, ''))}$` };
        if (d.kind === 'span_decoration') {
          bp.dec = { cond: d.condition ?? '', tags: d.capture?.tags ?? [], rate: d.max_rate_per_min ?? 60, exp: (d.expires_at ?? 0) * 1000 };
        }
        bps.push(bp);
      } catch { /* a probe we cannot evaluate is skipped */ }
    }
    live = next;
    o.post?.(bps);
  };
  const onHit = (h: { ids: string[]; fn: string; url: string; line: number; vars: Vars }): void => {
    for (const id of h.ids) {
      const p = live.get(id);
      if (!p || !allowed(p, h.vars)) continue;
      const cap = p.def.capture ?? {};
      const attrs: Record<string, string> = { 'probe.id': id, 'code.function': h.fn, 'code.filepath': h.url, 'code.lineno': String(h.line) };
      if (p.def.message) attrs['probe.message'] = p.def.message;
      const snap = capture(h.vars, Math.min(cap.locals_depth || 3, 3), Math.min(cap.max_bytes || 8192, 8192));
      for (const [k, v] of Object.entries(snap)) attrs[`code.snapshot.${k}`] = v;
      try { emit('probe.snapshot', attrs); } catch { /* the app must never fail because of a probe */ }
    }
  };
  const poll = async (): Promise<void> => {
    const q = new URLSearchParams({ service: o.service ?? process.env.OTEL_SERVICE_NAME ?? 'unknown', env: o.env ?? '', version: o.version ?? '',
      kinds: 'log,snapshot,metric,span,span_decoration' });
    const headers: Record<string, string> = { authorization: `Bearer ${o.key ?? process.env.WT_INGEST_KEY ?? ''}` };
    if (etag) headers['if-none-match'] = etag;
    try {
      const r = await (o.fetch ?? fetch)(`${endpoint}/v1/probes/active?${q}`, { headers, signal: AbortSignal.timeout(10_000) });
      if (r.status !== 200) return;
      etag = r.headers.get('etag') ?? '';
      set(((await r.json()) as { probes?: ProbeDef[] }).probes ?? []);
    } catch { /* retried on the next poll */ }
  };
  return { set, poll, onHit, live: () => live };
}

/** Poll active probes and hook them through an inspector worker; `stop()` detaches everything. */
export function startProbes(o: ProbesOptions = {}): { stop(): Promise<void> } {
  const w = new Worker(WORKER, { eval: true });
  w.unref();
  const p = createProbes({ ...o, post: (defs) => w.postMessage(defs) });
  w.on('message', p.onHit);
  w.on('error', () => { /* probes stay off; the app keeps running */ });
  void p.poll();
  const timer = setInterval(() => void p.poll(), Math.max(o.intervalMs ?? 30_000, 5_000));
  timer.unref();
  return {
    async stop() {
      clearInterval(timer);
      w.postMessage([]);
      await new Promise((r) => setTimeout(r, 100));
      await w.terminate();
    },
  };
}
