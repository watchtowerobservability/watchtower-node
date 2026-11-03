import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { captureException } from '../errors.js';
import * as wt from '../index.js';

/** The slice of the Azure Functions v4 InvocationContext this wrapper reads. */
export interface AzureContextLike {
  invocationId?: string;
  functionName?: string;
  options?: { trigger?: { type?: string } };
}

const PUBSUB = ['serviceBusTrigger', 'eventHubTrigger', 'queueTrigger', 'eventGridTrigger', 'kafkaTrigger', 'rabbitMQTrigger'];
const DATASOURCE = ['blobTrigger', 'cosmosDBTrigger', 'sqlTrigger'];

/** Maps an Azure binding type to the OTel `faas.trigger` value. */
export function faasTrigger(type: string | undefined): string {
  if (type === 'httpTrigger') return 'http';
  if (type === 'timerTrigger') return 'timer';
  if (type && PUBSUB.includes(type)) return 'pubsub';
  if (type && DATASOURCE.includes(type)) return 'datasource';
  return 'other';
}

let cold = true;

/** app.http('fn', { handler: wrapFunction(async (request, context) => ...) }). One span per
 * invocation with cold start, invocation id and trigger; errors captured; HTTP 5xx results mark the
 * span failed; spans flushed before the host may freeze the worker. */
export function wrapFunction<T, R, C extends AzureContextLike = AzureContextLike>(
  handler: (trigger: T, context: C) => Promise<R>,
  o?: { name?: string },
): (trigger: T, context: C) => Promise<R> {
  return async (input, context) => {
    const c: AzureContextLike = context || {};
    const coldstart = cold;
    cold = false;
    const kind = faasTrigger(c.options?.trigger?.type);
    return trace.getTracer('watchtower').startActiveSpan(o?.name || c.functionName || 'function', {
      kind: kind === 'http' ? SpanKind.SERVER : SpanKind.CONSUMER,
      attributes: {
        'cloud.provider': 'azure',
        'cloud.platform': 'azure_functions',
        'faas.name': c.functionName,
        'faas.invocation_id': c.invocationId,
        'faas.trigger': kind,
        'faas.coldstart': coldstart,
      },
    }, async (span) => {
      try {
        const r = await handler(input, context);
        const status = (r as { status?: unknown } | undefined)?.status;
        if (kind === 'http' && typeof status === 'number') {
          span.setAttribute('http.response.status_code', status);
          if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
        }
        return r;
      } catch (e) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        captureException(e, { handled: false, attributes: { 'error.mechanism': 'azure_functions' } });
        throw e;
      } finally {
        span.end();
        await wt.flush().catch(() => {});
      }
    });
  };
}
