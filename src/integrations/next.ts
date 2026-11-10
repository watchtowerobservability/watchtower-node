// instrumentation.js:  module.exports = require('@watchtowerobservability/node/next');
//   or, with options: export const register = makeRegister({ redact });  export { onRequestError } from '@watchtowerobservability/node/next';
import * as wt from '../index.js';

/** Build a Next.js instrumentation `register` that passes `options` to `init`; no-op off the Node.js runtime or without a key. */
export function makeRegister(options: wt.InitOptions = {}): () => Promise<void> {
  return async function register(): Promise<void> {
    const rt = process.env.NEXT_RUNTIME;
    if ((rt && rt !== 'nodejs') || !(options.apiKey || process.env.WT_INGEST_KEY)) return;
    wt.init(options);
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
