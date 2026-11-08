// Offline buffer: failed OTLP batches (spans, log records or metrics) are spooled to disk, at most
// `maxFiles` batches per signal directory (oldest dropped), and replayed oldest first before the
// next export, so they go out as soon as the endpoint is reachable again.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { SpanExporter, ReadableSpan } from '@opentelemetry/sdk-trace';
import type { LogRecordExporter, ReadableLogRecord } from '@opentelemetry/sdk-logs';
import type { AggregationTemporality, InstrumentType, PushMetricExporter, ResourceMetrics } from '@opentelemetry/sdk-metrics';
import { need } from './load.js';

const ser = () => need<typeof import('@opentelemetry/otlp-transformer')>('@opentelemetry/otlp-transformer');

type Done = Parameters<SpanExporter['export']>[1];

/** What the spool wraps: a span, log record or metric exporter; `B` is one export batch. */
export interface BatchExporter<B> {
  export(batch: B, done: Done): void;
  shutdown(): Promise<void>;
  forceFlush?(): Promise<void>;
}

export interface SpoolOptions<B = ReadableSpan[]> {
  maxFiles?: number;
  encode?: (batch: B) => Uint8Array;
}

/** OTLP/JSON encoders for the three signals. */
export const encodeSpans = (spans: ReadableSpan[]): Uint8Array => Buffer.from(ser().JsonTraceSerializer.serializeRequest(spans)!);
export const encodeLogs = (logs: ReadableLogRecord[]): Uint8Array => Buffer.from(ser().JsonLogsSerializer.serializeRequest(logs)!);
export const encodeMetrics = (rm: ResourceMetrics): Uint8Array => Buffer.from(ser().JsonMetricsSerializer.serializeRequest(rm)!);

export class SpoolExporter<B = ReadableSpan[]> implements BatchExporter<B> {
  private readonly maxFiles: number;
  private readonly encode: (batch: B) => Uint8Array;

  constructor(
    private readonly inner: BatchExporter<B>,
    private readonly dir: string,
    private readonly url: string,
    private readonly headers: Record<string, string>,
    private readonly fetch: typeof globalThis.fetch,
    opts?: SpoolOptions<B>,
  ) {
    this.maxFiles = (opts && opts.maxFiles) || 500;
    this.encode = (opts && opts.encode) || (encodeSpans as unknown as (batch: B) => Uint8Array);
    fs.mkdirSync(dir, { recursive: true });
  }

  private _files(): string[] {
    return fs.readdirSync(this.dir)
      .map((n) => ({ n, t: fs.statSync(path.join(this.dir, n)).mtimeMs }))
      .sort((a, b) => a.t - b.t || a.n.localeCompare(b.n))
      .map((f) => f.n);
  }

  async replay(): Promise<void> {
    for (const n of this._files()) {
      const p = path.join(this.dir, n);
      try {
        const res = await this.fetch(this.url, {
          method: 'POST',
          headers: { ...this.headers, 'Content-Type': 'application/json' },
          body: fs.readFileSync(p),
        });
        if (!res.ok) return;
      } catch {
        return; // still offline; keep order
      }
      fs.unlinkSync(p);
    }
  }

  export(batch: B, done: Done): void {
    void this.replay().then(() => this.inner.export(batch, (r) => {
      if (r.code !== 0) this._spool(this.encode(batch));
      done(r);
    }));
  }

  private _spool(payload: Uint8Array): void {
    const files = this._files();
    for (const old of files.slice(0, Math.max(0, files.length - this.maxFiles + 1))) {
      fs.unlinkSync(path.join(this.dir, old)); // drop-oldest
    }
    fs.writeFileSync(path.join(this.dir, `${crypto.randomUUID()}.json`), payload);
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush ? this.inner.forceFlush() : Promise.resolve();
  }
}

/** A spool for log records: same directory rules, `/v1/logs` replay. */
export const spoolLogs = (inner: LogRecordExporter, dir: string, url: string, headers: Record<string, string>,
  fetch: typeof globalThis.fetch, opts?: { maxFiles?: number }): SpoolExporter<ReadableLogRecord[]> =>
  new SpoolExporter<ReadableLogRecord[]>(inner, dir, url, headers, fetch, { ...opts, encode: encodeLogs });

/** A spool for metrics (`/v1/metrics` replay); the reader still asks the real exporter for temporality. */
export class MetricSpool extends SpoolExporter<ResourceMetrics> implements PushMetricExporter {
  constructor(private readonly metricInner: PushMetricExporter, dir: string, url: string, headers: Record<string, string>,
    fetch: typeof globalThis.fetch, opts?: { maxFiles?: number }) {
    super(metricInner, dir, url, headers, fetch, { ...opts, encode: encodeMetrics });
  }

  selectAggregationTemporality(t: InstrumentType): AggregationTemporality {
    const pick = this.metricInner.selectAggregationTemporality;
    return pick ? pick.call(this.metricInner, t) : 1 as AggregationTemporality; // CUMULATIVE, the SDK default (enum value, so sdk-metrics is not imported eagerly)
  }

  forceFlush(): Promise<void> {
    return this.metricInner.forceFlush();
  }
}
