// Own file: the global tracer provider can be set once per process.
import { expect, test } from 'vitest';
import { trace } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace';
import * as wt from '../src/index.js';
import { attachProcessors, foreignProvider } from '../src/attach.js';

test('no provider registered: nothing to attach to', () => {
  expect(foreignProvider()).toBeUndefined();
});

test('attaches to an already registered provider instead of replacing it', async () => {
  const added: { onEnd(s: unknown): void }[] = [];
  const other = { getTracer: () => ({ startSpan: () => ({}), startActiveSpan: () => undefined }), addSpanProcessor: (p: never) => added.push(p) };
  trace.setGlobalTracerProvider(other as never);
  expect(foreignProvider()).toBe(other);
  const seen: ReadableSpan[] = [];
  const c = wt.init({
    apiKey: 'k', captureProcessErrors: false, logs: false, metrics: false, instrument: false,
    exporter: { export: (s: ReadableSpan[], done: (r: { code: number }) => void) => { seen.push(...s); done({ code: 0 }); }, shutdown: async () => {}, forceFlush: async () => {} },
  });
  expect(c.attached).toBe(true);
  expect(c.provider).toBe(other);
  expect(c.traces).toBe('ok');
  expect(c.blocked).toEqual([]);
  expect(added.length).toBeGreaterThanOrEqual(2); // url scrubber, redactor, batch processor
  expect(foreignProvider()).toBe(other); // global untouched
  await c.forceFlush();
  await c.shutdown(); // flushes our processors only, never `other`
});

test("otel: 'own' builds its own provider even when one is registered", () => {
  const c = new wt.Client({ apiKey: 'k', otel: 'own', logs: false, metrics: false, exporter: { export: (_: unknown, d: (r: { code: number }) => void) => d({ code: 0 }), shutdown: async () => {}, forceFlush: async () => {} } });
  expect(c.attached).toBe(false);
});

test('attachProcessors: v2 private list, and false when there is no hook', () => {
  const list: unknown[] = [];
  expect(attachProcessors({ _activeSpanProcessor: { _spanProcessors: list } }, [1, 2])).toBe(true);
  expect(list).toEqual([1, 2]);
  expect(attachProcessors({}, [1])).toBe(false);
});
