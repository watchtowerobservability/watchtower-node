import { SpanKind, trace } from '@opentelemetry/api';
import { captureException } from '../errors.js';
import * as wt from '../index.js';

/** The slice of the Lambda context this wrapper reads. */
export interface LambdaContextLike {
  functionName?: string;
  awsRequestId?: string;
  invokedFunctionArn?: string;
}

/** exports.handler = wrapHandler(async (event, context) => ...). Async handlers only. Flushes before the
 * runtime freezes, otherwise buffered spans are lost. */
export function wrapHandler<E, R, C extends LambdaContextLike = LambdaContextLike>(
  handler: (event: E, context: C) => Promise<R>,
  o?: { name?: string },
): (event: E, context: C) => Promise<R> {
  const x = o || {};
  return async (event, context) => {
    const c: LambdaContextLike = context || {};
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
