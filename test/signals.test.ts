import { test, expect } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { SpanContext } from '@opentelemetry/api';
import { Resource } from '@opentelemetry/resources';
import { AggregationTemporality, InstrumentType } from '@opentelemetry/sdk-metrics';
import type { PushMetricExporter, ResourceMetrics } from '@opentelemetry/sdk-metrics';
import * as wt from '../src/index.js';
import { MetricSpool } from '../src/buffer.js';
import { switchOn } from '../src/metrics.js';

interface Got { path: string; auth: string | undefined; body: Record<string, any> }

async function otlpServer(): Promise<{ got: Got[]; url: string; close: () => Promise<void> }> {
  const got: Got[] = [];
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c: Buffer) => { b += c.toString(); });
    req.on('end', () => {
      got.push({ path: req.url || '', auth: req.headers.authorization, body: JSON.parse(b || '{}') });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const { port } = srv.address() as AddressInfo;
  return { got, url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

test('logs carry the active trace and span ids and metrics are delta, both on the OTLP endpoint', async () => {
  delete process.env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE;
  const s = await otlpServer();
  const c = wt.init({ apiKey: 'test-key-not-real', endpoint: s.url, captureProcessErrors: false });
  let ctx: SpanContext | undefined;
  c.tracer.startActiveSpan('op', (span) => {
    c.log('info', 'hello');
    ctx = span.spanContext();
    span.end();
  });
  wt.metrics.getMeter('t').createCounter('jobs.done').add(3);
  await c.forceFlush();
  await wt.shutdown();
  await s.close();

  const logs = s.got.filter((g) => g.path === '/v1/logs');
  expect(logs.length).toBeGreaterThan(0);
  expect(logs.every((g) => g.auth === 'Bearer test-key-not-real')).toBe(true);
  const rec = logs.flatMap((g) => g.body.resourceLogs).flatMap((r) => r.scopeLogs).flatMap((x) => x.logRecords)
    .find((r) => r.body.stringValue === 'hello');
  expect(rec.traceId).toBe(ctx!.traceId);
  expect(rec.spanId).toBe(ctx!.spanId);

  const metric = s.got.filter((g) => g.path === '/v1/metrics').flatMap((g) => g.body.resourceMetrics)
    .flatMap((r) => r.scopeMetrics).flatMap((x) => x.metrics).find((m) => m.name === 'jobs.done');
  expect(metric.sum.aggregationTemporality).toBe(1); // AGGREGATION_TEMPORALITY_DELTA
  expect(Number(metric.sum.dataPoints[0].asDouble ?? metric.sum.dataPoints[0].asInt)).toBe(3);
});

test('failed metric export is spooled and replayed to /v1/metrics', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-spool-metrics-'));
  let up = false;
  const posted: string[] = [];
  const fetch = (async (url: string) => {
    if (!up) throw new Error('offline');
    posted.push(url);
    return { ok: true };
  }) as unknown as typeof globalThis.fetch;
  const inner = {
    export: (_m: ResourceMetrics, done: (r: { code: number }) => void) => done({ code: up ? 0 : 1 }),
    selectAggregationTemporality: () => AggregationTemporality.DELTA,
    shutdown: async () => {},
    forceFlush: async () => {},
  };
  const s = new MetricSpool(inner as unknown as PushMetricExporter, dir, 'http://x/v1/metrics', {}, fetch);
  // the reader sees the inner exporter's preference
  expect(s.selectAggregationTemporality(InstrumentType.COUNTER)).toBe(AggregationTemporality.DELTA);
  const batch = { resource: Resource.default(), scopeMetrics: [] } as unknown as ResourceMetrics;
  const exp = (): Promise<void> => new Promise((r) => s.export(batch, () => r()));
  await exp();
  expect(fs.readdirSync(dir)).toHaveLength(1);
  up = true;
  await exp();
  expect(posted).toEqual(['http://x/v1/metrics']);
  expect(fs.readdirSync(dir)).toHaveLength(0);
});

test('WATCHTOWER_LOGS / WATCHTOWER_METRICS and OTEL_*_EXPORTER=none switch signals off', () => {
  const env = process.env;
  env.WATCHTOWER_LOGS = 'off';
  expect(switchOn('WATCHTOWER_LOGS', 'OTEL_LOGS_EXPORTER')).toBe(false);
  expect(switchOn('WATCHTOWER_LOGS', 'OTEL_LOGS_EXPORTER', true)).toBe(true);
  delete env.WATCHTOWER_LOGS;
  env.OTEL_METRICS_EXPORTER = 'none';
  expect(switchOn('WATCHTOWER_METRICS', 'OTEL_METRICS_EXPORTER')).toBe(false);
  delete env.OTEL_METRICS_EXPORTER;
  expect(switchOn('WATCHTOWER_METRICS', 'OTEL_METRICS_EXPORTER')).toBe(true);
});
