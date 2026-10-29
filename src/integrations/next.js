'use strict';
// instrumentation.js:  module.exports = require('@watchtowerobservability/node/next');
const wt = require('../index');

/** Next.js instrumentation hook: init from WT_* env on the Node.js runtime; no-op without WT_INGEST_KEY. */
async function register() {
  const rt = process.env.NEXT_RUNTIME;
  if ((rt && rt !== 'nodejs') || !process.env.WT_INGEST_KEY) return;
  wt.init({});
}

/** Next.js onRequestError: server render, route handler and server action errors. */
async function onRequestError(err, request, context) {
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

module.exports = { register, onRequestError };
