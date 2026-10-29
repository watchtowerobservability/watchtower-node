'use strict';
const { context, trace, SpanKind, SpanStatusCode } = require('@opentelemetry/api');

/** Start a server span; finish(status, route) names it `METHOD route` and ends it once. */
function serverSpan(method, path) {
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
      if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
    },
  };
}

const statusOf = (e) => (e && (e.status || e.statusCode)) || 500;

module.exports = { serverSpan, statusOf };
