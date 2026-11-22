import { context } from '@opentelemetry/api';
import { captureException } from '../errors.js';
import { capturePayload, captureActive } from '../payload.js';
import { adoptServerSpan, serverSpan, statusOf } from './util.js';
import type { ServerSpan } from './util.js';

const KEY = Symbol('wt.span');
const SENT = Symbol('wt.sent');
const seenErrors = new WeakSet<object>(); // one event per Error object, even if the app also calls captureException

/** Plugin options. */
export interface FastifyPluginOptions {
  /** Capture 5xx errors in an onError hook. Default true. */
  captureErrors?: boolean;
}

interface FastifyRequestLike {
  method: string;
  url: string;
  routeOptions?: { url?: string };
  routerPath?: string;
  /** Parsed by Fastify's content-type parser (payload capture). */
  body?: unknown;
  headers?: Record<string, string | string[] | undefined>;
  [KEY]?: ServerSpan;
  [SENT]?: unknown;
}

interface FastifyReplyLike {
  statusCode: number;
  getHeader?: (name: string) => unknown;
}

/** The slice of a Fastify instance this plugin uses. `any` args: Fastify types each hook's handler separately. */
export interface FastifyLike {
  addHook(name: string, fn: (...args: any[]) => void): unknown;
}

/** await app.register(plugin): server span per request (or the http instrumentation's own server span, enriched) plus 5xx error capture. */
export function plugin(fastify: FastifyLike, opts: FastifyPluginOptions | undefined, done: (err?: Error) => void): void {
  fastify.addHook('onRequest', (req: FastifyRequestLike, _reply: unknown, next: () => void) => {
    // with the http instrumentation active its server span is enriched (route, status) instead of starting a second one
    const s = adoptServerSpan(req.method) ?? serverSpan(req.method, req.url);
    req[KEY] = s;
    context.with(s.ctx, next);
  });
  if (opts?.captureErrors !== false) {
    fastify.addHook('onError', (req: FastifyRequestLike, _reply: unknown, err: unknown, next: () => void) => {
      const dup = err !== null && typeof err === 'object' && seenErrors.has(err);
      if (err !== null && typeof err === 'object') seenErrors.add(err);
      if (!dup && statusOf(err) >= 500) captureException(err, { route: (req.routeOptions && req.routeOptions.url) || req.routerPath });
      next();
    });
  }
  // the serialized response body (string, Buffer or stream); passed on unchanged
  fastify.addHook('onSend', (req: FastifyRequestLike, _reply: unknown, payload: unknown, next: (err: null, p: unknown) => void) => {
    if (captureActive()) req[SENT] = payload;
    next(null, payload);
  });
  fastify.addHook('onResponse', (req: FastifyRequestLike, reply: FastifyReplyLike, next: () => void) => {
    const route = (req.routeOptions && req.routeOptions.url) || req.routerPath;
    const s = req[KEY];
    if (s && captureActive()) {
      capturePayload(s.span, {
        route: route || req.url.split('?')[0]!,
        reqType: String((req.headers && req.headers['content-type']) || ''), reqBody: req.body,
        resType: String((reply.getHeader && reply.getHeader('content-type')) || ''), resBody: req[SENT],
      });
    }
    if (s) s.finish(reply.statusCode, route);
    next();
  });
  done();
}
(plugin as unknown as Record<symbol, unknown>)[Symbol.for('skip-override')] = true; // what fastify-plugin sets: hooks apply app-wide
