import * as dc from 'node:diagnostics_channel';
import { context, SpanStatusCode } from '@opentelemetry/api';
import type { Span } from '@opentelemetry/api';
import { querySummary } from '../sql.js';
import { startDbSpan } from './db.js';
import type { DbOptions } from './db.js';

/** The `postgres:query` context postgres.js (>= 4) publishes; only these fields are read. */
interface QueryContext {
  query?: string | null;
  database?: string;
  host?: string | null;
  port?: number | null;
  command?: string | null;
  count?: number | null;
  error?: unknown;
}

export { querySummary };

/**
 * postgres.js has no OTel instrumentation; since 4.0 it publishes each query on the
 * `postgres:query` diagnostics tracing channel. This turns those into CLIENT spans (child of the
 * active span) with `db.system=postgresql`, the operation, a summary and `db.query.hash` (no
 * statement text or parameters unless `opts.queryText`, then literal-free) and the SQLSTATE on
 * failure. Works for ESM and CJS; returns an unsubscribe function (a no-op when this Node has no
 * tracing channels).
 */
export function instrumentPostgres(opts?: DbOptions): () => void {
  if (typeof dc.tracingChannel !== 'function') return () => {};
  const ch = dc.tracingChannel<string, QueryContext & object>('postgres:query');
  const spans = new WeakMap<object, Span>();
  const handlers = {
    start(c: QueryContext & object) {
      spans.set(c, startDbSpan({
        system: 'postgresql', sql: c.query, namespace: c.database, attributes: { 'db.system': 'postgresql' },
      }, opts, context.active()));
    },
    end() {},
    asyncStart() {},
    error(c: QueryContext & object) {
      const span = spans.get(c);
      if (!span) return;
      const code = (c.error as { code?: unknown } | undefined)?.code;
      if (typeof code === 'string') {
        span.setAttribute('db.response.status_code', code);
        span.setAttribute('error.type', code);
      }
      // the message can quote values (e.g. a duplicate key), so it is not recorded
      span.setStatus({ code: SpanStatusCode.ERROR, message: typeof code === 'string' ? `SQLSTATE ${code}` : undefined });
    },
    asyncEnd(c: QueryContext & object) {
      const span = spans.get(c);
      if (!span) return;
      spans.delete(c);
      if (c.host) span.setAttribute('server.address', c.host);
      if (c.port) span.setAttribute('server.port', c.port);
      if (typeof c.count === 'number') span.setAttribute('db.response.returned_rows', c.count);
      span.end();
    },
  };
  ch.subscribe(handlers);
  return () => ch.unsubscribe(handlers);
}
