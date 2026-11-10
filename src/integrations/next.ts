// instrumentation.js:  module.exports = require('@watchtowerobservability/node/next');
//   or, with options: export const register = makeRegister({ redact });  export { onRequestError } from '@watchtowerobservability/node/next';
import { SpanStatusCode } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace';
import * as wt from '../index.js';

export { withWatchtower, uploadSourcemaps } from './next-build.js';
export type { SourcemapOptions } from './next-build.js';
export { tunnelHandler } from './next-tunnel.js';
export type { TunnelOptions } from './next-tunnel.js';

export interface NextOptions extends wt.InitOptions {
  /**
   * Next.js's own spans (`next.span_type` set: load route module, prepare route module, resolve page components, start
   * response, middleware, generateMetadata ...). `"sample"` (default) keeps `nextInternalsRate` of them, `"drop"` none,
   * `"keep"` all. Request (`BaseServer.handleRequest`), route handler, render, server action and fetch spans, every
   * SERVER/CLIENT span and every errored span are always kept. A dropped span's children stay in the trace.
   */
  nextInternals?: 'drop' | 'sample' | 'keep';
  /** Share of internal spans kept with `nextInternals: "sample"`; default 0.1. */
  nextInternalsRate?: number;
}

const KEEP_TYPES = new Set([
  'BaseServer.handleRequest', 'AppRouteRouteHandlers.runHandler', 'AppRender.fetch', 'AppRender.getBodyResult',
  'Render.getServerSideProps', 'Render.getStaticProps', 'NextNodeServer.runApi',
]);
const KEEP_NAMES = /^(render route|executing api route|fetch |.*server action)/i;

/** Whether `span` is one of Next's internal spans (not a request, route handler, render, server action or fetch). */
export function isNextInternal(span: ReadableSpan): boolean {
  const type = span.attributes['next.span_type'];
  if (typeof type !== 'string') return false;
  return !KEEP_TYPES.has(type) && !KEEP_NAMES.test(span.name) && span.kind !== 1 && span.kind !== 2 && span.status.code !== SpanStatusCode.ERROR;
}

/** The `spanFilter` for a `nextInternals` mode; `rand` is injectable for tests. */
export function nextInternalsFilter(mode: 'drop' | 'sample' | 'keep' = 'sample', rate = 0.1, rand: () => number = Math.random): (s: ReadableSpan) => boolean {
  return (s) => mode === 'keep' || !isNextInternal(s) || (mode === 'sample' && rand() < rate);
}

/** Build a Next.js instrumentation `register` that passes `options` to `init`; no-op off the Node.js runtime or without a key. */
export function makeRegister(options: NextOptions = {}): () => Promise<void> {
  return async function register(): Promise<void> {
    const rt = process.env.NEXT_RUNTIME;
    if ((rt && rt !== 'nodejs') || !(options.apiKey || process.env.WT_INGEST_KEY)) return;
    const { nextInternals, nextInternalsRate, ...init } = options;
    const own = nextInternalsFilter(nextInternals, nextInternalsRate);
    wt.init({ ...init, spanFilter: init.spanFilter ? (s) => own(s) && init.spanFilter!(s) : own });
  };
}

/** Next.js instrumentation hook: init from WT_* env on the Node.js runtime; no-op without WT_INGEST_KEY. */
export const register = makeRegister();

/** Next.js onRequestError: server render, route handler and server action errors. */
export async function onRequestError(
  err: unknown,
  request?: { path?: string; method?: string },
  context?: { routerKind?: string; routePath?: string; routeType?: string },
): Promise<void> {
  const c = context || {};
  wt.captureException(err, {
    attributes: {
      'http.request.method': request && request.method,
      'url.path': request && request.path && String(request.path).split('?')[0],
      'http.route': c.routePath,
      'next.router_kind': c.routerKind,
      'next.route_type': c.routeType,
    },
  });
}
