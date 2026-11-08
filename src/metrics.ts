// Metrics: the OTel metrics SDK with a periodic OTLP/HTTP reader. Counters and histograms use
// delta temporality unless OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE is set. Node runtime
// metrics (event loop delay and utilization, GC, heap) come from the optional peer
// @opentelemetry/instrumentation-runtime-node when it is installed.
import * as nodePath from 'node:path';
import type { Resource } from '@opentelemetry/resources';
import type { MeterProvider, PushMetricExporter } from '@opentelemetry/sdk-metrics';
import { MetricSpool } from './buffer.js';
import { load, need } from './load.js';

/** Explicit flag, else `WATCHTOWER_LOGS` / `WATCHTOWER_METRICS` (default on); `OTEL_*_EXPORTER=none` turns it off. */
export function switchOn(name: string, otelExporterEnv: string, flag?: boolean): boolean {
  if (flag !== undefined) return flag;
  const env = process.env;
  if ((env[otelExporterEnv] || '').trim().toLowerCase() === 'none') return false;
  return !['off', 'false', '0', 'no'].includes((env[name] || 'on').trim().toLowerCase());
}

interface Runtime { setMeterProvider(p: MeterProvider): void; disable(): void }

export interface Metrics { provider: MeterProvider; stop(): void }

export function startMetrics(endpoint: string, headers: Record<string, string>, resource: Resource,
  bufferDir: string | undefined, fetch: typeof globalThis.fetch, exporter?: PushMetricExporter): Metrics {
  const sdk = need<typeof import('@opentelemetry/sdk-metrics')>('@opentelemetry/sdk-metrics');
  const url = `${endpoint}/v1/metrics`;
  let exp: PushMetricExporter | undefined = exporter;
  if (!exp) {
    const { AggregationTemporalityPreference, OTLPMetricExporter } = need<typeof import('@opentelemetry/exporter-metrics-otlp-http')>('@opentelemetry/exporter-metrics-otlp-http');
    const delta = process.env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE
      ? {} : { temporalityPreference: AggregationTemporalityPreference.DELTA };
    exp = new OTLPMetricExporter({ url, headers, ...delta });
    if (bufferDir) exp = new MetricSpool(exp, nodePath.join(bufferDir, 'metrics'), url, headers, fetch);
  }
  const interval = Number(process.env.OTEL_METRIC_EXPORT_INTERVAL) || 60000;
  const reader = new sdk.PeriodicExportingMetricReader({
    exporter: exp, exportIntervalMillis: interval, exportTimeoutMillis: Math.min(30000, interval),
  });
  const provider = new sdk.MeterProvider({ resource, readers: [reader] });
  let runtime: Runtime | undefined;
  try {
    const mod = load('@opentelemetry/instrumentation-runtime-node') as { RuntimeNodeInstrumentation: new () => Runtime };
    runtime = new mod.RuntimeNodeInstrumentation();
    runtime.setMeterProvider(provider);
  } catch {
    // optional peer not installed
  }
  return { provider, stop: () => runtime?.disable() };
}
