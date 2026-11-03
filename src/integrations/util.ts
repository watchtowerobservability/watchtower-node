import { context, trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { Context, Span } from '@opentelemetry/api';

export interface ServerSpan {
  span: Span;
  ctx: Context;
  finish(status?: number, route?: string): void;
}

/** Start a server span; finish(status, route) names it `METHOD route` and ends it once. */
export function serverSpan(method: string, path?: string): ServerSpan {
  // url.path only: query strings can carry secrets
  const span = trace.getTracer('watchtower').startSpan(method, {
    kind: SpanKind.SERVER,
    attributes: { 'http.request.method': method, 'url.path': String(path || '').split('?')[0] },
  });
  let done = false;
  return {
    span,
    ctx: trace.setSpan(context.active(), span),
    finish(status, route) {
      if (done) return;
      done = true;
      if (route) { span.updateName(`${method} ${route}`); span.setAttribute('http.route', route); }
      if (status) span.setAttribute('http.response.status_code', status);
      if (status !== undefined && status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
    },
  };
}

export const statusOf = (e: unknown): number => {
  const x = e as { status?: number; statusCode?: number } | null | undefined;
  return (x && (x.status || x.statusCode)) || 500;
};
