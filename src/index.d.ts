import type { Tracer, trace as TraceApi } from '@opentelemetry/api';

export const DEFAULT_ENDPOINT: string;

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

export type Scorers = Record<string, (testCase: any, output: any) => unknown | Promise<unknown>>;

export class Client {
  constructor(opts: InitOptions);
  readonly endpoint: string;
  readonly headers: { Authorization: string };
  readonly tracer: Tracer;
  getPrompt(promptId: string): Promise<unknown>;
  score(traceId: string, value: number | boolean | string, o?: { name?: string; spanId?: string; comment?: string }): Promise<unknown>;
  evaluate(dataset: unknown[], task: (input: any) => unknown | Promise<unknown>, scorers: Scorers, o?: EvalOptions): Promise<EvalRow[]>;
  evaluateResume(dataset: unknown[], task: (input: any) => unknown | Promise<unknown>, scorers: Scorers, previous: EvalRow[], o?: EvalOptions): Promise<EvalRow[]>;
  observe<A extends unknown[], R>(name: string, fn: (...a: A) => R): (...a: A) => R;
  log(level: LogLevel, body: string, attributes?: Record<string, unknown>): void;
  forceFlush(): Promise<unknown>;
  shutdown(): Promise<void>;
}

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
export interface CaptureContext {
  /** false for crashes (uncaught); default true. Keys starting with `wt.` are dropped. */
  handled?: boolean;
  attributes?: Record<string, string | number | boolean | undefined>;
}
/** Record an error on the active span (or a new one). Returns the trace id. */
export function captureException(err: unknown, ctx?: CaptureContext): string;
export function flush(): Promise<unknown>;
export function log(level: LogLevel, body: string, attributes?: Record<string, unknown>): void;

export function init(opts: InitOptions): Client;
export function safeResource(attrs?: Record<string, unknown>): Record<string, unknown>;
export function getPrompt(promptId: string): Promise<unknown>;
export function score(traceId: string, value: number | boolean | string, o?: { name?: string; spanId?: string; comment?: string }): Promise<unknown>;
export function evaluate(dataset: unknown[], task: (input: any) => unknown | Promise<unknown>, scorers: Scorers, o?: EvalOptions): Promise<EvalRow[]>;
export function evaluateResume(dataset: unknown[], task: (input: any) => unknown | Promise<unknown>, scorers: Scorers, previous: EvalRow[], o?: EvalOptions): Promise<EvalRow[]>;
export function observe<A extends unknown[], R>(name: string, fn: (...a: A) => R): (...a: A) => R;
export function shutdown(): Promise<void>;
export const trace: typeof TraceApi;
