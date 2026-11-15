import * as dc from 'node:diagnostics_channel';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { context, diag, SpanStatusCode } from '@opentelemetry/api';
import type { Span } from '@opentelemetry/api';
import { load } from '../load.js';
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

let warned = false;
// Warn once, and only when postgres is installed (load is real, but cheap: cached): without tracingChannel nothing would ever be recorded.
function warnOnce(): void {
  if (warned) return;
  warned = true;
  try { load('postgres'); } catch { return; }
  diag.warn('watchtower: instrumentPostgres() is a no-op: this Node has no diagnostics_channel.tracingChannel; postgres@>=4 on a Node that provides it is required');
}

/**
 * postgres.js has no OTel instrumentation; since 4.0 it publishes each query on the
 * `postgres:query` diagnostics tracing channel. This turns those into CLIENT spans (child of the
 * active span) with `db.system=postgresql`, the operation, a summary and `db.query.hash` (no
 * statement text or parameters unless `opts.queryText`, then literal-free) and the SQLSTATE on
 * failure. Works for ESM and CJS; returns an unsubscribe function (a no-op when this Node has no
 * tracing channels).
 */
/** Major version of the app's installed `postgres`, or undefined when absent or unreadable. */
export function postgresMajor(from: string = process.cwd()): number | undefined {
  try {
    // `postgres/package.json` is not exported, so walk up from the resolved entry.
    let dir = dirname(createRequire(join(from, 'noop.js')).resolve('postgres'));
    for (let i = 0; i < 6; i++, dir = dirname(dir)) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string };
        if (pkg.name === 'postgres') return Number.parseInt(pkg.version ?? '', 10);
      } catch { /* keep walking */ }
    }
  } catch { /* not installed */ }
  return undefined;
}

export function instrumentPostgres(opts?: DbOptions): () => void {
  if (typeof dc.tracingChannel !== 'function') {
    warnOnce();
    return () => {};
  }
  const major = postgresMajor();
  if (major !== undefined && major < 4) {
    diag.warn(`watchtower: instrumentPostgres() records nothing with postgres@${major}: the postgres:query channel exists only in postgres@>=4`);
  }
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
