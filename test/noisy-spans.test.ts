import { describe, expect, it, vi } from 'vitest';
import type { ReadableSpan } from '@opentelemetry/sdk-trace';
import { filterExporter, isNoisySpan, quotaWarnExporter, resetQuotaWarning } from '../src/filter.js';

const span = (name: string, attributes: Record<string, unknown> = {}, code = 0): ReadableSpan =>
  ({ name, attributes, status: { code } }) as unknown as ReadableSpan;

describe('isNoisySpan', () => {
  it('drops pool connects, bare transaction brackets and express middleware layers', () => {
    expect(isNoisySpan(span('pg-pool.connect'))).toBe(true);
    expect(isNoisySpan(span('BEGIN'))).toBe(true);
    expect(isNoisySpan(span('pg.query:COMMIT', { 'db.statement': 'COMMIT' }))).toBe(true);
    expect(isNoisySpan(span('x', { 'db.query.text': 'ROLLBACK;' }))).toBe(true);
    expect(isNoisySpan(span('middleware - jsonParser'))).toBe(true);
    expect(isNoisySpan(span('middleware - expressInit'))).toBe(true);
    expect(isNoisySpan(span('router - query'))).toBe(true);
  });
  it('keeps real statements, request handlers and errored spans', () => {
    expect(isNoisySpan(span('pg.query:SELECT users', { 'db.statement': 'SELECT 1' }))).toBe(false);
    expect(isNoisySpan(span('request handler - /orders'))).toBe(false);
    expect(isNoisySpan(span('pg-pool.connect', {}, 2))).toBe(false);
  });
});

describe('quotaWarnExporter', () => {
  it('warns once when the exporter fails with 429', () => {
    resetQuotaWarning();
    const warn = vi.fn();
    const inner = { export: (_s: unknown, done: (r: unknown) => void) => done({ code: 1, error: Object.assign(new Error('Export failed with retryable status 429'), { code: 429 }) }), shutdown: async () => {} };
    const ex = quotaWarnExporter(inner as never, warn);
    ex.export([], () => {});
    ex.export([], () => {});
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/^\[watchtower\] traces are being dropped: daily quota reached/);
  });
  it('filterExporter drops filtered spans before the inner exporter', () => {
    const seen: number[] = [];
    const inner = { export: (s: unknown[], done: (r: unknown) => void) => { seen.push(s.length); done({ code: 0 }); }, shutdown: async () => {} };
    filterExporter(inner as never, (s) => !isNoisySpan(s)).export([span('BEGIN'), span('GET /')], () => {});
    expect(seen).toEqual([1]);
  });
});
