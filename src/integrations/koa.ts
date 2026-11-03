import { context } from '@opentelemetry/api';
import { captureException } from '../errors.js';
import { capturePayload, captureActive } from '../payload.js';
import { serverSpan, statusOf } from './util.js';

/** The slice of a Koa context this integration reads. */
export interface KoaContext {
  method: string;
  path: string;
  status: number;
  _matchedRoute?: string;
  /** `body` is set by a body parser (koa-bodyparser, koa-body) for payload capture. */
  request?: { body?: unknown; type?: string };
  /** The response body the handler set (payload capture; streams are skipped). */
  body?: unknown;
  response?: { type?: string };
}

/** app.use(middleware()) first: server span per request, errors captured then rethrown. */
export function middleware(): (ctx: KoaContext, next: () => Promise<unknown>) => Promise<void> {
  return async (ctx, next) => {
    const s = serverSpan(ctx.method, ctx.path);
    let status: number | undefined;
    try {
      await context.with(s.ctx, next);
      status = ctx.status;
    } catch (e) {
      status = statusOf(e);
      if (status >= 500) context.with(s.ctx, () => captureException(e));
      throw e;
    } finally {
      if (captureActive()) {
        capturePayload(s.span, {
          route: ctx._matchedRoute || ctx.path,
          reqType: ctx.request?.type, reqBody: ctx.request?.body,
          resType: ctx.response?.type, resBody: ctx.body,
        });
      }
      s.finish(status, ctx._matchedRoute);
    }
  };
}
