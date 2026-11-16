// Drop spans at export time: `keep` returns false to drop a finished span (used for Next.js internal spans).
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace';

export function filterExporter(inner: SpanExporter, keep: (s: ReadableSpan) => boolean): SpanExporter {
  return {
    export(spans, done) {
      const kept = spans.filter(keep);
      if (kept.length) inner.export(kept, done);
      else done({ code: 0 });
    },
    shutdown: () => inner.shutdown(),
    forceFlush: () => inner.forceFlush?.() ?? Promise.resolve(),
  };
}

const BRACKET = /^\s*(BEGIN|COMMIT|ROLLBACK)\s*;?\s*$/i;
const BRACKET_NAME = /^(pg\.query:)?(BEGIN|COMMIT|ROLLBACK)$/i;
const EXPRESS_LAYER = /^(middleware - |router - )?(query|expressInit)$/;

/**
 * Low-value auto-instrumentation spans dropped by default (`noisySpans: true` keeps them): the `pg-pool.connect` wait, bare
 * `BEGIN` / `COMMIT` / `ROLLBACK` statements, and Express middleware layers (`middleware - *`, `expressInit`, `query`).
 * Errored spans are always kept.
 */
export function isNoisySpan(s: ReadableSpan): boolean {
  if (s.status.code === 2) return false; // SpanStatusCode.ERROR
  const name = s.name;
  if (name === 'pg-pool.connect') return true;
  const stmt = s.attributes['db.query.text'] ?? s.attributes['db.statement'];
  if (typeof stmt === 'string' ? BRACKET.test(stmt) : BRACKET_NAME.test(name)) return true;
  return name.startsWith('middleware - ') || s.attributes['express.type'] === 'middleware' || EXPRESS_LAYER.test(name);
}

let quotaWarned = false;
/** Logs once when the ingest endpoint answers 429 (daily quota or rate limit), which the OTLP exporter would otherwise swallow. */
export function quotaWarnExporter(inner: SpanExporter, warn: (msg: string) => void = (m) => console.warn(m)): SpanExporter {
  return {
    export(spans, done) {
      inner.export(spans, (r) => {
        const e = r.error as (Error & { code?: number; data?: string }) | undefined;
        if (!quotaWarned && e && (e.code === 429 || /\b429\b|daily quota/.test(`${e.message} ${e.data ?? ''}`))) {
          quotaWarned = true;
          const why = /daily quota reached[^"\n]*/.exec(`${e.data ?? ''} ${e.message}`)?.[0] ?? 'ingest answered 429, usually the daily quota; check GET /v1/projects/{prj}/settings/quotas';
          warn(`[watchtower] traces are being dropped: daily quota reached (${why})`);
        }
        done(r);
      });
    },
    shutdown: () => inner.shutdown(),
    forceFlush: () => inner.forceFlush?.() ?? Promise.resolve(),
  };
}

/** Test hook: lets the once-only warning fire again. */
export function resetQuotaWarning(): void {
  quotaWarned = false;
}
