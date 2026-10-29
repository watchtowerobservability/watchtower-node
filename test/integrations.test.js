'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { trace } = require('@opentelemetry/api');
const wt = require('../src');
const { installProcessHandlers } = require('../src/errors');

// the OTel global provider can be registered once per process: one init for the whole file
const spans = [];
const logs = [];
wt.init({
  apiKey: 'test-key-not-real',
  environment: 'staging',
  release: '1.2.3',
  captureProcessErrors: false,
  exporter: { export: (s, done) => { spans.push(...s); done({ code: 0 }); }, shutdown: async () => {}, forceFlush: async () => {} },
  logExporter: { export: (l, done) => { logs.push(...l); done({ code: 0 }); }, shutdown: async () => {}, forceFlush: async () => {} },
});

async function drain() {
  await wt.flush();
  await new Promise((r) => setImmediate(r));
  return spans.splice(0);
}
const named = (all, name) => all.find((s) => s.name === name);

test('captureException records exception event and trace id, drops wt.*, dedupes', async () => {
  const err = new Error('boom');
  const tid = wt.captureException(err, { attributes: { 'wt.tenant_id': 'x', route: '/a' } });
  assert.match(tid, /^[0-9a-f]{32}$/);
  assert.strictEqual(wt.captureException(err), tid);
  const [s] = await drain();
  assert.strictEqual(s.name, 'exception');
  assert.strictEqual(s.spanContext().traceId, tid);
  assert.strictEqual(s.events.length, 1);
  assert.strictEqual(s.events[0].attributes['exception.message'], 'boom');
  assert.strictEqual(s.attributes.route, '/a');
  assert.strictEqual(s.attributes['wt.tenant_id'], undefined);
  assert.strictEqual(s.attributes['error.handled'], true);
});

test('captureException on the active span reuses its trace', async () => {
  const f = wt.observe('op', () => wt.captureException('plain string'));
  const tid = f();
  const [s] = await drain();
  assert.strictEqual(s.name, 'op');
  assert.strictEqual(s.spanContext().traceId, tid);
  assert.strictEqual(s.events[0].attributes['exception.message'], 'plain string');
});

test('resource carries environment and release from options', async () => {
  wt.observe('r', () => 1)();
  const [s] = await drain();
  assert.strictEqual(s.resource.attributes['deployment.environment.name'], 'staging');
  assert.strictEqual(s.resource.attributes['service.version'], '1.2.3');
});

test('client never prints the key', () => {
  const c = new wt.Client({ apiKey: 'secret-key-value', exporter: { export() {}, shutdown: async () => {} } });
  assert.ok(!JSON.stringify(c).includes('secret-key-value'));
  assert.ok(!require('node:util').inspect(c).includes('secret-key-value'));
});

test('process handlers capture and exit only as sole listener', async () => {
  const proc = Object.assign(new EventEmitter(), { exit: (c) => proc.emit('exited', c) });
  const off = installProcessHandlers(async () => {}, proc);
  const exited = new Promise((r) => proc.once('exited', r));
  const orig = console.error;
  console.error = () => {};
  proc.emit('uncaughtException', new Error('fatal-1'));
  assert.strictEqual(await exited, 1);
  console.error = orig;
  assert.strictEqual((await drain())[0].attributes['error.mechanism'], 'uncaughtException');

  // another listener present: capture, but do not exit
  let didExit = false;
  proc.exit = () => { didExit = true; };
  proc.on('unhandledRejection', () => {});
  proc.emit('unhandledRejection', new Error('rej'));
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(didExit, false);
  assert.strictEqual((await drain())[0].attributes['error.mechanism'], 'unhandledRejection');
  off();
  assert.strictEqual(proc.listenerCount('uncaughtException'), 0);
});

test('express: route-named span, 5xx captured, 4xx not', async () => {
  const { requestHandler, errorHandler } = require('../src/integrations/express');
  const req = { method: 'GET', originalUrl: '/u/1?token=abc', baseUrl: '/api', route: { path: '/u/:id' } };
  const res = Object.assign(new EventEmitter(), { statusCode: 200 });
  let active;
  requestHandler()(req, res, () => { active = trace.getActiveSpan(); });
  assert.ok(active);
  res.emit('finish');
  res.emit('close');
  errorHandler()(Object.assign(new Error('bad'), { status: 400 }), req, res, () => {});
  const err500 = new Error('server');
  let passed;
  errorHandler()(err500, req, res, (e) => { passed = e; });
  assert.strictEqual(passed, err500);
  const all = await drain();
  const s = named(all, 'GET /api/u/:id');
  assert.ok(s);
  assert.strictEqual(s.attributes['url.path'], '/u/1');
  assert.strictEqual(s.attributes['http.response.status_code'], 200);
  assert.strictEqual(all.filter((x) => x.name === 'exception').length, 1);
});

test('koa: error captured on the request trace and rethrown', async () => {
  const { middleware } = require('../src/integrations/koa');
  const ctx = { method: 'POST', path: '/p', status: 404, _matchedRoute: '/p' };
  await assert.rejects(middleware()(ctx, async () => { throw new Error('koa-fail'); }), /koa-fail/);
  const s = named(await drain(), 'POST /p');
  assert.strictEqual(s.attributes['http.response.status_code'], 500);
  assert.strictEqual(s.events[0].attributes['exception.message'], 'koa-fail');
});

test('fastify: hooks produce a span and capture 5xx', async () => {
  const { plugin } = require('../src/integrations/fastify');
  assert.strictEqual(plugin[Symbol.for('skip-override')], true);
  const hooks = {};
  plugin({ addHook: (n, f) => { hooks[n] = f; } }, {}, () => {});
  const req = { method: 'GET', url: '/f?x=1', routeOptions: { url: '/f' } };
  hooks.onRequest(req, {}, () => {});
  hooks.onError(req, {}, new Error('fastify-fail'), () => {});
  hooks.onResponse(req, { statusCode: 500 }, () => {});
  const all = await drain();
  const s = named(all, 'GET /f');
  assert.ok(s);
  assert.strictEqual(s.attributes['http.route'], '/f');
  assert.ok(named(all, 'exception'));
});

test('nestjs interceptor captures 5xx with handler names and re-emits the error', async () => {
  const { WatchtowerInterceptor } = require('../src/integrations/nestjs');
  class Obs {
    constructor(fn) { this.fn = fn; }
    subscribe(o) { return this.fn({ next: (v) => o.next(v), error: (e) => o.error(e), complete: () => o.complete() }); }
    pipe(op) { return op(this); }
  }
  class UsersController { get() {} }
  const execCtx = { getClass: () => UsersController, getHandler: () => UsersController.prototype.get };
  const failing = new Obs((sub) => sub.error(new Error('nest-fail')));
  const out = new WatchtowerInterceptor().intercept(execCtx, { handle: () => failing });
  const seen = await new Promise((resolve) => out.subscribe({ error: resolve }));
  assert.strictEqual(seen.message, 'nest-fail');
  const [s] = await drain();
  assert.strictEqual(s.attributes['code.namespace'], 'UsersController');
  assert.strictEqual(s.attributes['code.function'], 'get');
  // 4xx HttpException is not captured
  const notFound = new Obs((sub) => sub.error(Object.assign(new Error('nf'), { getStatus: () => 404 })));
  await new Promise((resolve) => new WatchtowerInterceptor().intercept(execCtx, { handle: () => notFound }).subscribe({ error: resolve }));
  assert.strictEqual((await drain()).length, 0);
});

test('next: onRequestError captures route attributes without the query string', async () => {
  const { onRequestError } = require('../src/integrations/next');
  await onRequestError(new Error('render'), { method: 'GET', path: '/blog?draft=1' }, { routePath: '/blog', routerKind: 'App Router' });
  const [s] = await drain();
  assert.strictEqual(s.attributes['url.path'], '/blog');
  assert.strictEqual(s.attributes['http.route'], '/blog');
});

test('next: register is a no-op without a key', async () => {
  const saved = process.env.WT_INGEST_KEY;
  delete process.env.WT_INGEST_KEY;
  await require('../src/integrations/next').register();
  if (saved) process.env.WT_INGEST_KEY = saved;
});

test('prisma extension wraps operations and records errors', async () => {
  const op = require('../src/integrations/prisma').watchtowerExtension().query.$allModels.$allOperations;
  assert.deepStrictEqual(await op({ model: 'User', operation: 'findMany', args: {}, query: async () => [1] }), [1]);
  await assert.rejects(op({ model: 'User', operation: 'create', args: {}, query: async () => { throw new Error('db'); } }), /db/);
  const all = await drain();
  assert.strictEqual(named(all, 'prisma User.findMany').attributes['db.operation.name'], 'findMany');
  assert.strictEqual(named(all, 'prisma User.create').status.code, 2);
});

test('lambda wrapper returns, captures errors and flushes', async () => {
  const { wrapHandler } = require('../src/integrations/lambda');
  const ctx = { functionName: 'fn', awsRequestId: 'r1' };
  assert.strictEqual(await wrapHandler(async (e) => e.v)({ v: 7 }, ctx), 7);
  await assert.rejects(wrapHandler(async () => { throw new Error('lam'); })({}, ctx), /lam/);
  const all = await drain();
  assert.strictEqual(all.filter((s) => s.name === 'fn').length, 2);
  assert.ok(all.some((s) => s.events.some((e) => e.attributes['exception.message'] === 'lam')));
});

test('genai: openai and anthropic spans use GenAI semconv and keep the original promise', async () => {
  const { instrumentOpenAI, instrumentAnthropic } = require('../src/integrations/genai');
  const reply = { id: 'c1', model: 'gpt-4o', choices: [{ finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 4 } };
  const original = Promise.resolve(reply);
  const openai = instrumentOpenAI({ chat: { completions: { create: () => original } } });
  assert.strictEqual(openai.chat.completions.create({ model: 'gpt-4o', max_tokens: 9 }), original);
  const anthropic = instrumentAnthropic({
    messages: { create: async () => ({ id: 'm1', model: 'claude-x', stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 6 } }) },
  });
  await anthropic.messages.create({ model: 'claude-x' });
  await assert.rejects(instrumentAnthropic({ messages: { create: async () => { throw new Error('429'); } } }).messages.create({ model: 'm' }), /429/);
  const all = await drain();
  const o = named(all, 'chat gpt-4o');
  assert.strictEqual(o.attributes['gen_ai.system'], 'openai');
  assert.strictEqual(o.attributes['gen_ai.usage.input_tokens'], 3);
  assert.strictEqual(o.attributes['gen_ai.request.max_tokens'], 9);
  assert.deepStrictEqual(o.attributes['gen_ai.response.finish_reasons'], ['stop']);
  const a = named(all, 'chat claude-x');
  assert.strictEqual(a.attributes['gen_ai.usage.output_tokens'], 6);
  assert.strictEqual(named(all, 'chat m').status.code, 2);
});

test('vercel ai telemetry defaults to no content', () => {
  const t = require('../src/integrations/genai').vercelAiTelemetry({ functionId: 'f' });
  assert.deepStrictEqual([t.isEnabled, t.recordInputs, t.recordOutputs, t.functionId], [true, false, false, 'f']);
});

test('logs: pino stream and winston transport emit OTLP logs with trace ids', async () => {
  const { pinoStream, watchtowerTransport } = require('../src/integrations/logs');
  const pino = pinoStream();
  wt.observe('with-logs', () => {
    pino.write(JSON.stringify({ level: 50, time: 1, pid: 1, hostname: 'h', msg: 'bad thing', user: { id: 1 }, 'wt.tenant_id': 'x' }));
    watchtowerTransport().log({ level: 'warn', message: 'careful', extra: 1 }, () => {});
  })();
  pino.write('not json'); // ignored
  const [span] = await drain();
  const [p, w] = logs.splice(0);
  assert.strictEqual(p.severityText, 'ERROR');
  assert.strictEqual(p.body, 'bad thing');
  assert.strictEqual(p.attributes.user, '{"id":1}');
  assert.strictEqual(p.attributes['wt.tenant_id'], undefined);
  assert.strictEqual(p.spanContext.traceId, span.spanContext().traceId);
  assert.strictEqual(w.severityText, 'WARN');
  assert.strictEqual(w.attributes.extra, 1);
});
