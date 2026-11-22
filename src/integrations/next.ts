// Deprecated entry: use `@watchtowerobservability/next` (register, onRequestError, withWatchtower). Still works unchanged.
// instrumentation.js:  module.exports = require('@watchtowerobservability/node/next');
//   or, with options: export const register = makeRegister({ redact });  export { onRequestError } from '@watchtowerobservability/node/next';
import * as wt from '../index.js';

import * as build from './next-build.js';

/** @deprecated use `withWatchtower` from `@watchtowerobservability/next` */
export const withWatchtower: typeof build.withWatchtower = build.withWatchtower;
/** @deprecated use `uploadSourcemaps` from `@watchtowerobservability/next` */
export const uploadSourcemaps: typeof build.uploadSourcemaps = build.uploadSourcemaps;
export type { SourcemapOptions } from './next-build.js';
export { isNextInternal, nextInternalsFilter } from '../next-filter.js';
export { tunnelHandler } from './next-tunnel.js';
export type { TunnelOptions } from './next-tunnel.js';

export type NextOptions = wt.InitOptions;

/** @deprecated use `register` from `@watchtowerobservability/next`.
 * Build a Next.js instrumentation `register` that passes `options` to `init`; no-op off the Node.js runtime or without a key. */
export function makeRegister(options: NextOptions = {}): () => Promise<void> {
  return async function register(): Promise<void> {
    const rt = process.env.NEXT_RUNTIME;
    if ((rt && rt !== 'nodejs') || !(options.apiKey || process.env.WT_INGEST_KEY)) return;
    wt.init({ ...options, nextInternals: options.nextInternals ?? 'sample' }); // init() applies the filter (once)
  };
}

/** @deprecated use `register` from `@watchtowerobservability/next`.
 * Next.js instrumentation hook: init from WT_* env on the Node.js runtime; no-op without WT_INGEST_KEY. */
export const register = makeRegister();

/** @deprecated use `onRequestError` from `@watchtowerobservability/next`.
 * Next.js onRequestError: server render, route handler and server action errors. */
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
