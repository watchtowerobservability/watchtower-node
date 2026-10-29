'use strict';
const { SpanKind, trace } = require('@opentelemetry/api');
const { captureException } = require('../errors');

/** exports.handler = wrapHandler(async (event, context) => ...). Async handlers only. Flushes before the
 * runtime freezes, otherwise buffered spans are lost. */
function wrapHandler(handler, o) {
  const x = o || {};
  return async (event, context) => {
    const wt = require('../index');
    const c = context || {};
    return trace.getTracer('watchtower').startActiveSpan(x.name || c.functionName || 'lambda', {
      kind: SpanKind.SERVER,
      attributes: {
        'cloud.provider': 'aws',
        'faas.name': c.functionName,
        'faas.invocation_id': c.awsRequestId,
        'cloud.resource_id': c.invokedFunctionArn,
      },
    }, async (span) => {
      try {
        return await handler(event, context);
      } catch (e) {
        captureException(e, { handled: false, attributes: { 'error.mechanism': 'lambda' } });
        throw e;
      } finally {
        span.end();
        await wt.flush().catch(() => {});
      }
    });
  };
}

module.exports = { wrapHandler };
