'use strict';
const { context } = require('@opentelemetry/api');
const { captureException } = require('../errors');
const { serverSpan, statusOf } = require('./util');

/** app.use(requestHandler()) first: a server span per request, named by the matched route. */
function requestHandler() {
  return (req, res, next) => {
    const s = serverSpan(req.method, req.originalUrl || req.url);
    const end = () => s.finish(res.statusCode, req.route && `${req.baseUrl || ''}${req.route.path}`);
    res.on('finish', end);
    res.on('close', end);
    context.with(s.ctx, next);
  };
}

/** app.use(errorHandler()) after all routes: captures 5xx errors, then passes them on. */
function errorHandler() {
  return (err, req, res, next) => {
    if (statusOf(err) >= 500) captureException(err, { attributes: { 'http.route': req.route && req.route.path } });
    next(err);
  };
}

module.exports = { requestHandler, errorHandler };
