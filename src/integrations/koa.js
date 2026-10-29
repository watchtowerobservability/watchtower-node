'use strict';
const { context } = require('@opentelemetry/api');
const { captureException } = require('../errors');
const { serverSpan, statusOf } = require('./util');

/** app.use(middleware()) first: server span per request, errors captured then rethrown. */
function middleware() {
  return async (ctx, next) => {
    const s = serverSpan(ctx.method, ctx.path);
    let status;
    try {
      await context.with(s.ctx, next);
      status = ctx.status;
    } catch (e) {
      status = statusOf(e);
      if (status >= 500) context.with(s.ctx, () => captureException(e));
      throw e;
    } finally {
      s.finish(status, ctx._matchedRoute);
    }
  };
}

module.exports = { middleware };
