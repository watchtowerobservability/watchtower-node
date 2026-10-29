'use strict';
const { captureException } = require('../errors');
const { statusOf } = require('./util');

/** app.useGlobalInterceptors(new WatchtowerInterceptor()): captures 5xx errors with controller and handler names.
 * Duck-typed over the rxjs Observable (no rxjs import); pair with the express or fastify integration for spans. */
class WatchtowerInterceptor {
  intercept(execCtx, next) {
    const where = {};
    try {
      where['code.namespace'] = execCtx.getClass().name;
      where['code.function'] = execCtx.getHandler().name;
    } catch (_) { /* non-http context */ }
    const source = next.handle();
    return source.pipe((src) => new src.constructor((sub) => src.subscribe({
      next: (v) => sub.next(v),
      error: (e) => {
        const status = typeof e.getStatus === 'function' ? e.getStatus() : statusOf(e);
        if (status >= 500) captureException(e, { attributes: where });
        sub.error(e);
      },
      complete: () => sub.complete(),
    })));
  }
}

module.exports = { WatchtowerInterceptor };
