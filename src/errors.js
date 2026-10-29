'use strict';
// Error capture: an exception becomes an OTel span event (exception.*) with trace and span ids.
const { trace, SpanStatusCode } = require('@opentelemetry/api');

const captured = new WeakMap(); // error object -> traceId, so framework + process hooks never double-report

function dropReserved(attrs) {
  return Object.fromEntries(Object.entries(attrs || {}).filter(([k]) => !k.startsWith('wt.')));
}

/** Record err on the active span (or a new `exception` span). Returns the trace id. */
function captureException(err, ctx) {
  const o = ctx || {};
  const e = err instanceof Error ? err : new Error(typeof err === 'string' ? err : JSON.stringify(err));
  if (captured.has(e)) return captured.get(e);
  const attrs = { 'error.handled': o.handled !== false, ...dropReserved(o.attributes) };
  let span = trace.getActiveSpan();
  const own = !span || !span.isRecording();
  if (own) span = trace.getTracer('watchtower').startSpan('exception');
  span.setAttributes(attrs);
  span.recordException(e);
  span.setStatus({ code: SpanStatusCode.ERROR, message: e.message });
  const traceId = span.spanContext().traceId;
  if (own) span.end();
  captured.set(e, traceId);
  return traceId;
}

/** uncaughtException / unhandledRejection hooks. Exits like Node would, but only when we are the sole listener. */
function installProcessHandlers(flush, proc) {
  const p = proc || process;
  const exitAfterFlush = () =>
    Promise.race([flush(), new Promise((r) => setTimeout(r, 2000).unref())]).finally(() => p.exit(1));
  const onException = (e) => {
    captureException(e, { handled: false, attributes: { 'error.mechanism': 'uncaughtException' } });
    if (p.listenerCount('uncaughtException') > 1) return;
    console.error(e);
    exitAfterFlush();
  };
  const onRejection = (reason) => {
    captureException(reason, { handled: false, attributes: { 'error.mechanism': 'unhandledRejection' } });
    if (p.listenerCount('unhandledRejection') > 1) return;
    console.error(reason);
    exitAfterFlush();
  };
  p.on('uncaughtException', onException);
  p.on('unhandledRejection', onRejection);
  return () => {
    p.off('uncaughtException', onException);
    p.off('unhandledRejection', onRejection);
  };
}

module.exports = { captureException, installProcessHandlers, dropReserved };
