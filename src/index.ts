// Thin Watchtower layer over the OpenTelemetry Node SDK: key header, endpoint default,
// offline buffer, wt.*-safe resource attributes, redaction hook, getPrompt/score/evaluate/observe.
import { inspect } from 'node:util';
import { context, diag, metrics, propagation, trace } from '@opentelemetry/api';
import type { Tracer } from '@opentelemetry/api';
import type { DetectedResourceAttributes, Resource } from '@opentelemetry/resources';
import type { ReadableSpan, SpanExporter, TracerProvider } from '@opentelemetry/sdk-trace';
import type { LoggerProvider, LogRecordExporter } from '@opentelemetry/sdk-logs';
import type { MeterProvider, PushMetricExporter } from '@opentelemetry/sdk-metrics';
import { need as needPeer } from './load.js';
import { otelEnv } from './env.js';
import { instrumentAll } from './instrument.js';
import { LOG_BODY_KEY, redactor } from './redact.js';
import { urlScrubber } from './scrub.js';
import { filterExporter } from './filter.js';
import { checkin as runCheckin } from './checkin.js';
import { installSignalFlush } from './shutdown.js';
import { VERSION } from './version.js';
import { SpoolExporter, spoolLogs } from './buffer.js';
import { startMetrics, switchOn } from './metrics.js';
import * as nodePath from 'node:path';
import { captureException, installProcessHandlers, dropReserved } from './errors.js';
import type { CaptureContext } from './errors.js';
import { loadCaptureRules } from './payload.js';
import { startProfiling } from './profiling.js';
import { RemoteSampler } from './sampling.js';
import { codeOrigin } from './origin.js';
import type { Profiler } from './profiling.js';

export { captureException, metrics, trace };
export { setCaptureRules, capturePayload } from './payload.js';
export type { CaptureRule } from './payload.js';
export type { CaptureContext };

export const DEFAULT_ENDPOINT = 'http://localhost:4318';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
/** code.filepath/code.lineno of the frame that called `log()` (stack line 0 is "Error", 1 is `log`, 2 the caller). */
export function callerOf(stack: string | undefined): Record<string, string | number> {
  const m = /\(?((?:file:\/\/)?[^()\s]+):(\d+):\d+\)?$/.exec((stack ?? '').split('\n')[2] ?? '');
  return m ? { 'code.filepath': m[1]!.replace(/^file:\/\//, ''), 'code.lineno': Number(m[2]) } : {};
}

const SEVERITY: Record<LogLevel, number> = { trace: 1, debug: 5, info: 9, warn: 13, error: 17, fatal: 21 };
type LogAttrs = Parameters<ReturnType<LoggerProvider['getLogger']>['emit']>[0]['attributes'];

export interface InitOptions {
  /** Ingest key; defaults to WT_INGEST_KEY, then a `Bearer` Authorization in OTEL_EXPORTER_OTLP_HEADERS. */
  apiKey?: string;
  /** Defaults to WT_ENVIRONMENT. */
  environment?: string;
  /** Sent as `service.version`; the server links an issue's first release by matching it to an existing release's version. Defaults to WT_RELEASE, then `service.version` in OTEL_RESOURCE_ATTRIBUTES. */
  release?: string;
  /** Hook uncaughtException / unhandledRejection (default true). */
  captureProcessErrors?: boolean;
  /** Replace the log exporter (tests); setting it turns logs on unless `logs` is false. Exported through a batch processor. */
  logExporter?: unknown;
  /** Export OTLP logs; defaults to WATCHTOWER_LOGS (on unless `off`; OTEL_LOGS_EXPORTER=none also turns it off). */
  logs?: boolean;
  /** Stamp code.filepath/code.lineno of the `log()` caller (reads the stack); defaults to WATCHTOWER_LOG_CALLER=1. */
  logCaller?: boolean;
  /** Export OTLP metrics; defaults to WATCHTOWER_METRICS (on unless `off`; OTEL_METRICS_EXPORTER=none also turns it off). */
  metrics?: boolean;
  /** Replace the metric exporter (tests); setting it turns metrics on unless `metrics` is false. */
  metricExporter?: unknown;
  /** OTLP/HTTP base URL; defaults to WT_OTLP_ENDPOINT, then OTEL_EXPORTER_OTLP_ENDPOINT, then http://localhost:4318. */
  endpoint?: string;
  /** REST API base URL for getPrompt/score; defaults to WT_API_URL or endpoint. */
  apiUrl?: string;
  project?: string;
  /** Defaults to WT_SERVICE, then OTEL_SERVICE_NAME, then `service.name` in OTEL_RESOURCE_ATTRIBUTES, then `app`. */
  serviceName?: string;
  /** Resource attributes (on top of OTEL_RESOURCE_ATTRIBUTES); keys starting with `wt.` are dropped. */
  resource?: Record<string, string | number | boolean>;
  /**
   * Called before export for every span attribute, every span event's and link's attributes (so `exception.message`
   * and `exception.stacktrace`), the span name (key `span.name`), the status message (`status.message`) and each log
   * body (`log.body`) and log attribute; return the value to keep.
   */
  redact?: (key: string, value: unknown) => unknown;
  /** Directory for the offline buffer. */
  bufferDir?: string;
  /** Apply the project's head sampling rules in the SDK, polled from /v1/sampling; defaults to WT_REMOTE_SAMPLING=1. Spans dropped here never reach the gateway, so its exact request counts see only what is kept. */
  remoteSampling?: boolean;
  /** Seconds between sampling polls; defaults to WT_SAMPLING_INTERVAL_S or 30. */
  samplingIntervalS?: number;
  /** Stamp code.filepath / code.lineno / code.function on spans (the code that started the span); defaults to WT_CODE_ORIGIN=1. */
  codeOrigin?: boolean;
  /** Fetch the service's payload capture rules (APM-016) and record bodies/GraphQL where a rule matches; defaults to WT_CAPTURE_RULES=1. */
  captureRules?: boolean;
  /** Replace the span exporter (tests). */
  exporter?: unknown;
  /**
   * Scrub URLs on every span, including spans other libraries create (Next.js, node:http, fetch): the query string is dropped
   * (`url.query` removed) and path segments that look like secrets or ids (>= 24 chars, or >= 10 chars mixing letters and digits,
   * UUIDs included) become `:redacted`, in `http.target`, `url.full`, `url.path`, `http.url` and URLs in span names.
   * `http.route` is kept. Default true; `false` records URLs as the instrumentation produced them.
   */
  urlScrubbing?: boolean;
  /** Return false to drop a finished span before export (the `/next` entry uses it for `nextInternals`). */
  spanFilter?: (span: ReadableSpan) => boolean;
  /**
   * Patch node:http, fetch (undici), pg and ioredis for those whose `@opentelemetry/instrumentation-*` peer is installed; defaults to on unless WT_INSTRUMENT=0.
   * `'auto'` (or WT_INSTRUMENT=auto) also instruments whichever of postgres.js, better-sqlite3 and mysql2 is installed and logs one line naming what it patched
   * (`instrumentLog: false` or WT_INSTRUMENT_LOG=0 silences it). `init` only: use the `/register` preload so it runs before the app imports them.
   */
  instrument?: boolean | 'auto';
  /** Print the one-line list of what `instrument: 'auto'` patched (default true). */
  instrumentLog?: boolean;
  fetch?: typeof fetch;
}

export interface EvalRow {
  case: number;
  traceId: string;
  scores: Record<string, unknown>;
  errors: Record<string, string>;
}

export interface EvalOptions {
  name?: string;
  errorTolerance?: boolean;
  /** Rows of an earlier run; cases that finished without errors are kept, not re-run. */
  resume?: EvalRow[];
}

// `any`: dataset case and task types are user-defined, so parameter types must stay assignable from them.
export type Scorers = Record<string, (testCase: any, output: any) => unknown | Promise<unknown>>;
export type EvalTask = (input: any) => unknown | Promise<unknown>;
export interface ScoreOptions { name?: string; spanId?: string; comment?: string }

/** Drop caller-supplied wt.* keys: tenant identity comes only from the key. */
export function safeResource(attrs?: Record<string, unknown>): Record<string, unknown> {
  return dropReserved(attrs);
}

const errMessage = (e: unknown): string => String((e as { message?: unknown } | null)?.message || e);

export class Client {
  readonly endpoint: string;
  readonly apiUrl: string;
  readonly project: string | undefined;
  readonly headers: { Authorization: string } & Record<string, string>;
  readonly fetch: typeof fetch;
  readonly redact: InitOptions['redact'];
  private readonly logCaller: boolean;
  readonly provider: TracerProvider;
  readonly resource: Resource;
  readonly tracer: Tracer;
  readonly loggerProvider: LoggerProvider;
  readonly logger: ReturnType<LoggerProvider['getLogger']>;
  /** Set when metrics are on; `init` makes it the global meter provider (`metrics.getMeter`). */
  readonly meterProvider?: MeterProvider;
  private readonly stopRuntime: () => void = () => {};
  uninstall?: () => void;
  /** Set when remote sampling is on. */
  remoteSampler?: RemoteSampler;
  /** Set when WT_PROFILING=1 started the continuous profiler. */
  profiler?: Promise<Profiler | undefined>;

  constructor(opts: InitOptions) {
    const o = opts || {};
    const env = process.env;
    const oe = otelEnv(env);
    const apiKey = o.apiKey || env.WT_INGEST_KEY || oe.bearer;
    if (!apiKey) throw new Error('apiKey is required (or set WT_INGEST_KEY)');
    this.endpoint = (o.endpoint || env.WT_OTLP_ENDPOINT || oe.endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, '');
    this.apiUrl = (o.apiUrl || env.WT_API_URL || this.endpoint).replace(/\/+$/, '');
    this.project = o.project || env.WT_PROJECT_ID;
    this.headers = { ...oe.headers, Authorization: `Bearer ${apiKey}` };
    this.fetch = o.fetch || globalThis.fetch;
    const environment = o.environment || env.WT_ENVIRONMENT || oe.resource['deployment.environment.name'];
    const release = o.release || env.WT_RELEASE || oe.resource['service.version'];
    // the OTel SDK packages are optional peers, loaded here (not at import time) with a clear error when missing
    const { resourceFromAttributes, defaultResource } = needPeer<typeof import('@opentelemetry/resources')>('@opentelemetry/resources');
    // the SDK's own telemetry.sdk.* (name, language, version): a bare resourceFromAttributes does not add them
    const sdk = (defaultResource().attributes ?? {}) as Record<string, unknown>;
    const resource = resourceFromAttributes({
      'telemetry.sdk.name': String(sdk['telemetry.sdk.name'] ?? 'opentelemetry'),
      'telemetry.sdk.language': String(sdk['telemetry.sdk.language'] ?? 'nodejs'),
      'telemetry.sdk.version': String(sdk['telemetry.sdk.version'] ?? 'unknown'),
      'telemetry.distro.name': 'watchtower',
      'telemetry.distro.version': VERSION,
      ...(safeResource(oe.resource) as DetectedResourceAttributes),
      'service.name': o.serviceName || env.WT_SERVICE || oe.serviceName || 'app',
      ...(environment ? { 'deployment.environment.name': environment } : {}),
      ...(release ? { 'service.version': release } : {}),
      ...(safeResource(o.resource) as DetectedResourceAttributes),
    });
    this.resource = resource;
    this.redact = o.redact;
    this.logCaller = o.logCaller ?? env.WATCHTOWER_LOG_CALLER === '1';
    let exporter = o.exporter as SpanExporter | undefined;
    if (!exporter) {
      const url = `${this.endpoint}/v1/traces`;
      const { OTLPTraceExporter } = needPeer<typeof import('@opentelemetry/exporter-trace-otlp-http')>('@opentelemetry/exporter-trace-otlp-http');
      exporter = new OTLPTraceExporter({ url, headers: this.headers });
      // spans and log records spool to their own subdirectories
      if (o.bufferDir) exporter = new SpoolExporter(exporter, nodePath.join(o.bufferDir, 'traces'), url, this.headers, this.fetch);
    }
    if (o.spanFilter) exporter = filterExporter(exporter, o.spanFilter);
    // the scrubber and redactor run first, so the batch processor exports scrubbed attributes (the user's `redact` sees scrubbed URLs)
    const { BatchSpanProcessor, TracerProvider: TP } = needPeer<typeof import('@opentelemetry/sdk-trace')>('@opentelemetry/sdk-trace');
    let sampler: unknown;
    if (o.remoteSampling ?? env.WT_REMOTE_SAMPLING === '1') {
      const { ParentBasedSampler } = needPeer<typeof import('@opentelemetry/sdk-trace')>('@opentelemetry/sdk-trace');
      this.remoteSampler = new RemoteSampler({
        endpoint: this.endpoint, headers: this.headers, service: String(resource.attributes['service.name']), env: environment,
        intervalMs: (o.samplingIntervalS ?? (Number(env.WT_SAMPLING_INTERVAL_S) || 30)) * 1000, fetch: this.fetch,
      });
      sampler = new ParentBasedSampler({ root: this.remoteSampler });
    }
    this.provider = new TP({
      resource,
      ...(sampler ? { sampler: sampler as never } : {}),
      spanProcessors: [
        ...(o.codeOrigin ?? env.WT_CODE_ORIGIN === '1' ? [codeOrigin()] : []),
        ...(o.urlScrubbing ?? true ? [urlScrubber()] : []),
        ...(o.redact ? [redactor(o.redact)] : []),
        new BatchSpanProcessor({ exporter }),
      ],
    });
    this.tracer = this.provider.getTracer('watchtower');
    // an explicit exporter never switches the other signals off: only `logs` / `metrics` / the env switches do
    const logsOn = switchOn('WATCHTOWER_LOGS', 'OTEL_LOGS_EXPORTER', o.logs ?? (o.logExporter ? true : undefined));
    let logExporter = logsOn ? (o.logExporter as LogRecordExporter | undefined) : undefined;
    if (logsOn && !logExporter) {
      const url = `${this.endpoint}/v1/logs`;
      const { OTLPLogExporter } = needPeer<typeof import('@opentelemetry/exporter-logs-otlp-http')>('@opentelemetry/exporter-logs-otlp-http');
      logExporter = new OTLPLogExporter({ url, headers: this.headers });
      if (o.bufferDir) logExporter = spoolLogs(logExporter, nodePath.join(o.bufferDir, 'logs'), url, this.headers, this.fetch);
    }
    const { LoggerProvider: LP, BatchLogRecordProcessor } = needPeer<typeof import('@opentelemetry/sdk-logs')>('@opentelemetry/sdk-logs');
    this.loggerProvider = new LP({
      resource,
      processors: !logExporter ? [] : [new BatchLogRecordProcessor({ exporter: logExporter })],
    });
    this.logger = this.loggerProvider.getLogger('watchtower');
    if (switchOn('WATCHTOWER_METRICS', 'OTEL_METRICS_EXPORTER', o.metrics ?? (o.metricExporter ? true : undefined))) {
      const m = startMetrics(this.endpoint, this.headers, resource, o.bufferDir, this.fetch, o.metricExporter as PushMetricExporter | undefined);
      this.meterProvider = m.provider;
      this.stopRuntime = m.stop;
    }
    if (o.captureRules ?? env.WT_CAPTURE_RULES === '1') {
      void loadCaptureRules({ apiUrl: this.apiUrl, key: apiKey, service: String(resource.attributes['service.name']), fetch: this.fetch });
    }
  }

  /** Emit an OTLP log record; trace and span ids come from the active context. */
  log(level: LogLevel, body: string, attributes?: Record<string, unknown>): void {
    let attrs = dropReserved(attributes);
    const redact = this.redact;
    if (redact) {
      attrs = Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, redact(k, v)]));
      body = String(redact(LOG_BODY_KEY, body) ?? '');
    }
    if (this.logCaller) attrs = { ...attrs, ...callerOf(new Error().stack) };
    this.logger.emit({
      severityNumber: SEVERITY[level] || SEVERITY.info,
      severityText: String(level).toUpperCase(),
      body,
      attributes: attrs as LogAttrs,
    });
  }

  /** Run `fn` as a cron / scheduler job with check-ins to the monitor `monitorSlug` (needs the `ingest:checkins` key scope): `in_progress`, then `ok` or `error` with the duration. */
  checkin<T>(monitorSlug: string, fn: () => T | Promise<T>): Promise<T> {
    return runCheckin(this, monitorSlug, fn);
  }

  forceFlush(): Promise<unknown> {
    return Promise.all([this.provider.forceFlush(), this.loggerProvider.forceFlush(), this.meterProvider?.forceFlush()]);
  }

  // keep the key out of console.log / JSON.stringify
  toJSON(): { endpoint: string; project: string | undefined; headers: { Authorization: string } } {
    return { endpoint: this.endpoint, project: this.project, headers: { Authorization: 'Bearer ****' } };
  }

  [inspect.custom](): string {
    return `Client ${JSON.stringify(this)}`;
  }

  private async _call(method: string, path: string, body?: unknown): Promise<unknown> {
    const url = `${this.apiUrl}/v1/projects/${this.project}/llm/${path}`;
    const res = await this.fetch(url, {
      method,
      headers: { ...this.headers, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`watchtower ${method} ${path}: HTTP ${res.status}`);
    return res.json();
  }

  getPrompt(promptId: string): Promise<unknown> {
    return this._call('GET', `prompts/${promptId}`);
  }

  score(traceId: string, value: number | boolean | string, o?: ScoreOptions): Promise<unknown> {
    const x = o || {};
    const body: Record<string, unknown> = { trace_id: traceId, value, name: x.name || 'user_feedback', source: 'sdk' };
    if (x.spanId) body.span_id = x.spanId;
    if (x.comment) body.comment = x.comment;
    return this._call('POST', 'scores', body);
  }

  /** Run task per case under a span; record each scorer result as a score when a project is set. */
  async evaluate(dataset: unknown[], task: EvalTask, scorers: Scorers, o?: EvalOptions): Promise<EvalRow[]> {
    const x = { name: 'evaluate', errorTolerance: true, ...o };
    const rows: EvalRow[] = [];
    // resume: rows of an earlier run; cases that finished without errors are kept, not re-run
    const done = new Map((x.resume || []).filter((r) => !Object.keys(r.errors || {}).length).map((r) => [r.case, r] as const));
    for (const [i, c] of dataset.entries()) {
      const kept = done.get(i);
      if (kept) { rows.push(kept); continue; }
      await this.tracer.startActiveSpan(`${x.name}.case`, async (span) => {
        const traceId = span.spanContext().traceId;
        const row: EvalRow = { case: i, traceId, scores: {}, errors: {} };
        rows.push(row);
        try {
          const input = c !== null && c !== undefined ? (c as { input?: unknown }).input : undefined;
          const out = await task(input !== undefined ? input : c);
          for (const [name, fn] of Object.entries(scorers)) {
            try {
              row.scores[name] = await fn(c, out);
              if (this.project) await this.score(traceId, row.scores[name] as number, { name });
            } catch (e) {
              if (!x.errorTolerance) throw e;
              row.errors[name] = errMessage(e);
            }
          }
        } catch (e) {
          if (!x.errorTolerance) throw e;
          row.errors.task = errMessage(e);
        } finally {
          span.end();
        }
      });
    }
    return rows;
  }

  /** Re-run only the cases that errored or are missing in `previous`. */
  evaluateResume(dataset: unknown[], task: EvalTask, scorers: Scorers, previous: EvalRow[], o?: EvalOptions): Promise<EvalRow[]> {
    return this.evaluate(dataset, task, scorers, { ...o, resume: previous });
  }

  /** Wrap fn in a span. */
  observe<A extends unknown[], R>(name: string, fn: (...a: A) => R): (...a: A) => R {
    return (...args: A): R => this.tracer.startActiveSpan(name, (span) => {
      const end = () => span.end();
      try {
        const r = fn(...args);
        if (r && typeof (r as { then?: unknown }).then === 'function') return (r as unknown as Promise<unknown>).finally(end) as R;
        end();
        return r;
      } catch (e) {
        end();
        throw e;
      }
    });
  }

  shutdown(): Promise<void> {
    this.stopRuntime();
    this.remoteSampler?.stop();
    return Promise.all([this.profiler?.then((p) => p?.stop()),this.provider.shutdown(), this.loggerProvider.shutdown(), this.meterProvider?.shutdown()]).then(() => undefined);
  }
}

// One state per process, not per module copy: a CommonJS and an ESM copy of this package (a `-r` preload plus an `import`
// app, say) must share the client or flush()/shutdown() in one copy would miss the init() of the other.
const state = ((globalThis as Record<symbol, unknown>)[Symbol.for('watchtower.node.state')] ??= {}) as { current?: Client; ownsGlobals?: boolean };

/**
 * Register the global tracer provider, context manager, propagator and meter provider. OTel allows each to be set once
 * (a second set returns false and changes nothing), so a provider the app or an earlier instrumentation registered is
 * left alone and a warning says so; only globals a previous `init` installed are torn down on a re-init.
 */
function registerGlobals(c: Client): void {
  if (state.ownsGlobals) { // a re-init replaces what the previous init installed
    trace.disable();
    context.disable();
    propagation.disable();
    metrics.disable();
  }
  const { AsyncLocalStorageContextManager } = needPeer<typeof import('@opentelemetry/context-async-hooks')>('@opentelemetry/context-async-hooks');
  const { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } = needPeer<typeof import('@opentelemetry/core')>('@opentelemetry/core');
  const ok = [
    trace.setGlobalTracerProvider(c.provider),
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable()),
    propagation.setGlobalPropagator(new CompositePropagator({ propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()] })),
    ...(c.meterProvider ? [metrics.setGlobalMeterProvider(c.meterProvider)] : []),
  ];
  state.ownsGlobals = ok[0] === true;
  if (ok.includes(false)) diag.warn('watchtower: an OpenTelemetry global (tracer provider, context manager, propagator or meter provider) was already registered and was kept; call init() before other OTel setup to own them');
}
export function init(opts: InitOptions): Client {
  if (state.current && state.current.uninstall) state.current.uninstall();
  void state.current?.profiler?.then((p) => p?.stop());
  const c = new Client(opts);
  state.current = c;
  registerGlobals(c);
  const env = (process.env.WT_INSTRUMENT || '').trim().toLowerCase();
  const mode = opts?.instrument ?? (env === 'auto' ? 'auto' : !['0', 'off', 'false', 'no'].includes(env));
  if (mode) {
    const names = instrumentAll({ tracerProvider: c.provider, meterProvider: c.meterProvider }, [c.endpoint, c.apiUrl], mode === 'auto');
    if (mode === 'auto' && (opts?.instrumentLog ?? !['0', 'off', 'false', 'no'].includes((process.env.WT_INSTRUMENT_LOG || '').trim().toLowerCase()))) {
      console.info(`[watchtower] instrumented: ${names.map((n) => n.replace('@opentelemetry/instrumentation-', '')).join(', ') || 'nothing (no supported package found)'}`);
    }
  }
  if (process.env.WT_PROFILING === '1') {
    const attrs = c.resource.attributes;
    c.profiler = startProfiling({
      apiKey: c.headers.Authorization.slice('Bearer '.length),
      endpoint: c.endpoint,
      service: String(attrs['service.name']),
      tags: { version: attrs['service.version'] as string | undefined },
    }).catch(() => undefined); // best effort: never break init
  }
  if ((opts || {}).captureProcessErrors !== false) {
    const offErrors = installProcessHandlers(() => c.forceFlush());
    const offSignals = installSignalFlush(() => c.forceFlush());
    c.uninstall = () => { offErrors(); offSignals(); };
  }
  return c;
}
function need(): Client {
  if (!state.current) throw new Error('watchtower.init() has not been called');
  return state.current;
}

export const checkin = <T>(slug: string, fn: () => T | Promise<T>): Promise<T> => need().checkin(slug, fn);
export const flush = (): Promise<unknown> => (state.current ? state.current.forceFlush() : Promise.resolve());
export const log = (l: LogLevel, b: string, a?: Record<string, unknown>): void => need().log(l, b, a);
export const getPrompt = (id: string): Promise<unknown> => need().getPrompt(id);
export const score = (t: string, v: number | boolean | string, o?: ScoreOptions): Promise<unknown> => need().score(t, v, o);
export const evaluate = (d: unknown[], t: EvalTask, s: Scorers, o?: EvalOptions): Promise<EvalRow[]> => need().evaluate(d, t, s, o);
export const evaluateResume = (d: unknown[], t: EvalTask, s: Scorers, prev: EvalRow[], o?: EvalOptions): Promise<EvalRow[]> =>
  need().evaluateResume(d, t, s, prev, o);
export const observe = <A extends unknown[], R>(n: string, f: (...a: A) => R): ((...a: A) => R) => need().observe(n, f);
export const shutdown = (): Promise<void> => (state.current ? state.current.shutdown() : Promise.resolve());
