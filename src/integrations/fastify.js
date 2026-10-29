'use strict';
const { context } = require('@opentelemetry/api');
const { captureException } = require('../errors');
const { serverSpan, statusOf } = require('./util');

const KEY = Symbol('wt.span');

/** await app.register(plugin): server span per request plus 5xx error capture. */
function plugin(fastify, _opts, done) {
  fastify.addHook('onRequest', (req, _reply, next) => {
    const s = serverSpan(req.method, req.url);
    req[KEY] = s;
    context.with(s.ctx, next);
  });
  fastify.addHook('onError', (req, _reply, err, next) => {
    if (statusOf(err) >= 500) captureException(err);
    next();
  });
  fastify.addHook('onResponse', (req, reply, next) => {
    const route = (req.routeOptions && req.routeOptions.url) || req.routerPath;
    if (req[KEY]) req[KEY].finish(reply.statusCode, route);
    next();
  });
  done();
}
plugin[Symbol.for('skip-override')] = true; // what fastify-plugin sets: hooks apply app-wide

module.exports = { plugin };
