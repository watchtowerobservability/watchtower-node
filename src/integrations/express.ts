import { context } from '@opentelemetry/api';
import { captureException } from '../errors.js';
import { capturePayload, captureActive, HARD_MAX } from '../payload.js';
import { serverSpan, statusOf } from './util.js';

/** The slice of an Express request this integration reads. */
export interface ExpressRequest {
  method: string;
  originalUrl?: string;
  url?: string;
  baseUrl?: string;
  route?: { path: string };
  /** Parsed by a body parser before this handler's span ends (payload capture). */
  body?: unknown;
  headers?: Record<string, string | string[] | undefined>;
}
/** The slice of an Express response this integration reads. */
export interface ExpressResponse {
  statusCode: number;
  on(event: string, listener: () => void): unknown;
  write?: (...a: unknown[]) => boolean;
  end?: (...a: unknown[]) => unknown;
  getHeader?: (name: string) => unknown;
}

/** Keep the first HARD_MAX * 2 response bytes for payload capture; the response itself is untouched. */
function tapBody(res: ExpressResponse): () => string {
  const chunks: Buffer[] = [];
  let size = 0;
  const keep = (c: unknown) => {
    if (size >= HARD_MAX * 2 || (typeof c !== 'string' && !Buffer.isBuffer(c))) return;
    const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
    chunks.push(b);
    size += b.length;
  };
  const { write, end } = res;
  if (write) res.write = (...a: unknown[]) => { keep(a[0]); return write.apply(res, a); };
  if (end) res.end = (...a: unknown[]) => { if (typeof a[0] !== 'function') keep(a[0]); return end.apply(res, a); };
  return () => Buffer.concat(chunks).toString('utf8');
}

/** app.use(requestHandler()) first: a server span per request, named by the matched route. */
export function requestHandler(): (req: ExpressRequest, res: ExpressResponse, next: (err?: unknown) => void) => void {
  return (req, res, next) => {
    const s = serverSpan(req.method, req.originalUrl || req.url);
    let body = captureActive() ? tapBody(res) : undefined;
    const end = () => {
      const route = req.route ? `${req.baseUrl || ''}${req.route.path}` : undefined;
      if (body) {
        const h = req.headers || {};
        capturePayload(s.span, {
          route: route || String(req.originalUrl || req.url || '').split('?')[0]!,
          reqType: String(h['content-type'] || ''), reqBody: req.body,
          resType: String((res.getHeader && res.getHeader('content-type')) || ''), resBody: body(),
        });
        body = undefined; // 'finish' and 'close' both fire; capture once
      }
      s.finish(res.statusCode, route);
    };
    res.on('finish', end);
    res.on('close', end);
    context.with(s.ctx, next);
  };
}

/** app.use(errorHandler()) after all routes: captures 5xx errors, then passes them on. */
export function errorHandler(): (err: unknown, req: ExpressRequest, res: ExpressResponse, next: (err?: unknown) => void) => void {
  return (err, req, _res, next) => {
    if (statusOf(err) >= 500) captureException(err, { attributes: { 'http.route': req.route && req.route.path } });
    next(err);
  };
}
