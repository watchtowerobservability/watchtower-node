// Thin Watchtower layer over the OpenTelemetry Node SDK: key header, endpoint default,
// offline buffer, wt.*-safe resource attributes, redaction hook, getPrompt/score/evaluate/observe.
import { inspect } from 'node:util';
import { metrics, trace } from '@opentelemetry/api';
import type { AttributeValue, Tracer } from '@opentelemetry/api';
import { Resource } from '@opentelemetry/resources';
import type { ResourceAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { SpanExporter, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { LoggerProvider, SimpleLogRecordProcessor, BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import type { LogRecordExporter } from '@opentelemetry/sdk-logs';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import type { MeterProvider, PushMetricExporter } from '@opentelemetry/sdk-metrics';
import { SpoolExporter, spoolLogs } from './buffer.js';
import { startMetrics, switchOn } from './metrics.js';
import * as nodePath from 'node:path';
import { captureException, installProcessHandlers, dropReserved } from './errors.js';
import type { CaptureContext } from './errors.js';
import { loadCaptureRules } from './payload.js';

export { captureException, metrics, trace };
export { setCaptureRules, capturePayload } from './payload.js';
export type { CaptureRule } from './payload.js';
export type { CaptureContext };

export const DEFAULT_ENDPOINT = 'http://localhost:4318';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
const SEVERITY: Record<LogLevel, number> = { trace: 1, debug: 5, info: 9, warn: 13, error: 17, fatal: 21 };
type LogAttrs = Parameters<ReturnType<LoggerProvider['getLogger']>['emit']>[0]['attributes'];

export interface InitOptions {
  /** Ingest key; defaults to WT_INGEST_KEY. */
  apiKey?: string;
  /** Defaults to WT_ENVIRONMENT. */
  environment?: string;
  /** Defaults to WT_RELEASE. */
  release?: string;
  /** Hook uncaughtException / unhandledRejection (default true). */
  captureProcessErrors?: boolean;
  /** Replace the log exporter (tests). */
  logExporter?: unknown;
  /** Export OTLP logs; defaults to WATCHTOWER_LOGS (on unless `off`; OTEL_LOGS_EXPORTER=none also turns it off). */
  logs?: boolean;
  /** Export OTLP metrics; defaults to WATCHTOWER_METRICS (on unless `off`; OTEL_METRICS_EXPORTER=none also turns it off). */
  metrics?: boolean;
  /** Replace the metric exporter (tests). */
  metricExporter?: unknown;
  /** OTLP/HTTP base URL; defaults to WT_OTLP_ENDPOINT or http://localhost:4318. */
  endpoint?: string;
  /** REST API base URL for getPrompt/score; defaults to WT_API_URL or endpoint. */
  apiUrl?: string;
  project?: string;
  /** Defaults to WT_SERVICE. */
  serviceName?: string;
  /** Resource attributes; keys starting with `wt.` are dropped. */
  resource?: Record<string, string | number | boolean>;
  /** Called for every span attribute before export; return the value to keep. */
  redact?: (key: string, value: unknown) => unknown;
  /** Directory for the offline buffer. */
  bufferDir?: string;
  /** Fetch the service's payload capture rules (APM-016) and record bodies/GraphQL where a rule matches; defaults to WT_CAPTURE_RULES=1. */
  captureRules?: boolean;
  /** Replace the span exporter (tests). */
  exporter?: unknown;
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
  readonly headers: { Authorization: string };
  readonly fetch: typeof fetch;
  readonly redact: InitOptions['redact'];
  readonly provider: NodeTracerProvider;
  readonly tracer: Tracer;
  readonly loggerProvider: LoggerProvider;
  readonly logger: ReturnType<LoggerProvider['getLogger']>;
  /** Set when metrics are on; `init` makes it the global meter provider (`metrics.getMeter`). */
  readonly meterProvider?: MeterProvider;
  private readonly stopRuntime: () => void = () => {};
  uninstall?: () => void;

  constructor(opts: InitOptions) {
    const o = opts || {};
    const env = process.env;
    const apiKey = o.apiKey || env.WT_INGEST_KEY;
    if (!apiKey) throw new Error('apiKey is required (or set WT_INGEST_KEY)');
    this.endpoint = (o.endpoint || env.WT_OTLP_ENDPOINT || DEFAULT_ENDPOINT).replace(/\/+$/, '');
    this.apiUrl = (o.apiUrl || env.WT_API_URL || this.endpoint).replace(/\/+$/, '');
    this.project = o.project || env.WT_PROJECT_ID;
    this.headers = { Authorization: `Bearer ${apiKey}` };
    this.fetch = o.fetch || globalThis.fetch;
    const environment = o.environment || env.WT_ENVIRONMENT;
    const release = o.release || env.WT_RELEASE;
    const resource = new Resource({
      'service.name': o.serviceName || env.WT_SERVICE || 'app',
      ...(environment ? { 'deployment.environment.name': environment } : {}),
      ...(release ? { 'service.version': release } : {}),
      ...(safeResource(o.resource) as ResourceAttributes),
    });
    this.redact = o.redact;
    this.provider = new NodeTracerProvider({ resource });
    if (o.redact) this.provider.addSpanProcessor(redactor(o.redact));
    let exporter = o.exporter as SpanExporter | undefined;
    if (!exporter) {
      const url = `${this.endpoint}/v1/traces`;
      exporter = new OTLPTraceExporter({ url, headers: this.headers });
      // spans and log records spool to their own subdirectories
      if (o.bufferDir) exporter = new SpoolExporter(exporter, nodePath.join(o.bufferDir, 'traces'), url, this.headers, this.fetch);
    }
    this.provider.addSpanProcessor(new BatchSpanProcessor(exporter));
    this.tracer = this.provider.getTracer('watchtower');
    this.loggerProvider = new LoggerProvider({ resource });
    const logsOn = switchOn('WATCHTOWER_LOGS', 'OTEL_LOGS_EXPORTER', o.logs);
    let logExporter = logsOn ? (o.logExporter as LogRecordExporter | undefined) : undefined;
    if (logsOn && !logExporter && !o.exporter) {
      const url = `${this.endpoint}/v1/logs`;
      logExporter = new OTLPLogExporter({ url, headers: this.headers });
      if (o.bufferDir) logExporter = spoolLogs(logExporter, nodePath.join(o.bufferDir, 'logs'), url, this.headers, this.fetch);
    }
    if (logExporter) {
      this.loggerProvider.addLogRecordProcessor(
        o.logExporter ? new SimpleLogRecordProcessor(logExporter) : new BatchLogRecordProcessor(logExporter));
    }
    this.logger = this.loggerProvider.getLogger('watchtower');
    // with a test span exporter only an explicit metric exporter is used, as for logs
    if (switchOn('WATCHTOWER_METRICS', 'OTEL_METRICS_EXPORTER', o.metrics) && (o.metricExporter || !o.exporter)) {
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
    if (redact) attrs = Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, redact(k, v)]));
    this.logger.emit({
      severityNumber: SEVERITY[level] || SEVERITY.info,
      severityText: String(level).toUpperCase(),
      body,
      attributes: attrs as LogAttrs,
    });
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
    return Promise.all([this.provider.shutdown(), this.loggerProvider.shutdown(), this.meterProvider?.shutdown()]).then(() => undefined);
  }
}

function redactor(hook: (key: string, value: unknown) => unknown): SpanProcessor {
  return {
    onStart() {},
    onEnd(span) {
      for (const k of Object.keys(span.attributes)) span.attributes[k] = hook(k, span.attributes[k]) as AttributeValue;
    },
    shutdown: () => Promise.resolve(),
    forceFlush: () => Promise.resolve(),
  };
}

let current: Client | undefined;
export function init(opts: InitOptions): Client {
  if (current && current.uninstall) current.uninstall();
  const c = new Client(opts);
  current = c;
  c.provider.register(); // global tracer + async context so trace.getActiveSpan() works
  if (c.meterProvider) {
    metrics.disable(); // a re-init replaces the previous client's provider
    metrics.setGlobalMeterProvider(c.meterProvider);
  }
  if ((opts || {}).captureProcessErrors !== false) {
    c.uninstall = installProcessHandlers(() => c.forceFlush());
  }
  return c;
}
function need(): Client {
  if (!current) throw new Error('watchtower.init() has not been called');
  return current;
}

export const flush = (): Promise<unknown> => (current ? current.forceFlush() : Promise.resolve());
export const log = (l: LogLevel, b: string, a?: Record<string, unknown>): void => need().log(l, b, a);
export const getPrompt = (id: string): Promise<unknown> => need().getPrompt(id);
export const score = (t: string, v: number | boolean | string, o?: ScoreOptions): Promise<unknown> => need().score(t, v, o);
export const evaluate = (d: unknown[], t: EvalTask, s: Scorers, o?: EvalOptions): Promise<EvalRow[]> => need().evaluate(d, t, s, o);
export const evaluateResume = (d: unknown[], t: EvalTask, s: Scorers, prev: EvalRow[], o?: EvalOptions): Promise<EvalRow[]> =>
  need().evaluateResume(d, t, s, prev, o);
export const observe = <A extends unknown[], R>(n: string, f: (...a: A) => R): ((...a: A) => R) => need().observe(n, f);
export const shutdown = (): Promise<void> => (current ? current.shutdown() : Promise.resolve());
