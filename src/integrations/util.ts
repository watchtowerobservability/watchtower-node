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

/** `/base/:id` from an Express (or Nest-on-Express) request: `baseUrl` plus the matched `route.path`; undefined when no string route matched. */
export function expressRoute(req: { baseUrl?: string; route?: { path?: unknown } }): string | undefined {
  const p = req.route?.path;
  return typeof p === 'string' ? `${req.baseUrl || ''}${p}` : undefined;
}

/** http instrumentation `applyCustomAttributesOnSpan` hook: when the response ends, name the server span `METHOD /route/:param`. Off with `WT_ROUTE_NAMES=0`. */
export function routeNamer(span: Span, req: { method?: string; baseUrl?: string; route?: { path?: unknown } }): void {
  if (['0', 'off', 'false', 'no'].includes((process.env.WT_ROUTE_NAMES || '').trim().toLowerCase())) return;
  const route = expressRoute(req);
  if (!route) return;
  span.updateName(`${req.method || 'GET'} ${route}`);
  span.setAttribute('http.route', route);
}

/** The active span when it is a recording SERVER span (made by the http instrumentation), wrapped so finish() enriches it and never ends it; else undefined. */
export function adoptServerSpan(method: string): ServerSpan | undefined {
  const span = trace.getActiveSpan();
  if (!span || !span.isRecording() || (span as unknown as { kind?: SpanKind }).kind !== SpanKind.SERVER) return undefined;
  return {
    span,
    ctx: context.active(),
    finish(status, route) {
      if (route) { span.updateName(`${method} ${route}`); span.setAttribute('http.route', route); }
      if (status) span.setAttribute('http.response.status_code', status);
      if (status !== undefined && status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
    },
  };
}
