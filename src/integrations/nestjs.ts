import { captureException } from '../errors.js';
import { statusOf } from './util.js';

/** The slice of Nest's ExecutionContext this interceptor reads. */
export interface NestExecutionContext {
  getClass(): { name: string };
  getHandler(): { name: string };
}

/** app.useGlobalInterceptors(new WatchtowerInterceptor()): captures 5xx errors with controller and handler names.
 * Duck-typed over the rxjs Observable (no rxjs import); pair with the express or fastify integration for spans. */
export class WatchtowerInterceptor {
  // `any`: the Observable is rxjs's, which this package deliberately does not import.
  intercept(execCtx: NestExecutionContext, next: { handle(): any }): any {
    const where: Record<string, string> = {};
    try {
      where['code.namespace'] = execCtx.getClass().name;
      where['code.function'] = execCtx.getHandler().name;
    } catch (_) { /* non-http context */ }
    const source = next.handle();
    return source.pipe((src: any) => new src.constructor((sub: any) => src.subscribe({
      next: (v: unknown) => sub.next(v),
      error: (e: { getStatus?: () => number }) => {
        const status = typeof e.getStatus === 'function' ? e.getStatus() : statusOf(e);
        if (status >= 500) captureException(e, { attributes: where });
        sub.error(e);
      },
      complete: () => sub.complete(),
    })));
  }
}
