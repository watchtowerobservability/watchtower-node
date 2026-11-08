import { test, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { inspect } from 'node:util';
import { trace } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace';
import * as wt from '../src/index.js';
import { installProcessHandlers } from '../src/errors.js';
import type { ProcessLike } from '../src/errors.js';
import { requestHandler, errorHandler } from '../src/integrations/express.js';
import type { ExpressRequest, ExpressResponse } from '../src/integrations/express.js';
import { middleware } from '../src/integrations/koa.js';
import { plugin } from '../src/integrations/fastify.js';
import { setCaptureRules } from '../src/payload.js';
import { WatchtowerInterceptor } from '../src/integrations/nestjs.js';
import { onRequestError, register } from '../src/integrations/next.js';
import { watchtowerExtension } from '../src/integrations/prisma.js';
import { wrapHandler } from '../src/integrations/lambda.js';
import { faasTrigger, wrapFunction } from '../src/integrations/azure-functions.js';
import { instrumentOpenAI, instrumentAnthropic, instrumentBedrock, instrumentGoogleGenAI, vercelAiTelemetry } from '../src/integrations/genai.js';
import { instrumentLlamaIndex, instrumentMistral, instrumentOllama, instrumentOpenAIAgents } from '../src/integrations/genai.js';
import { pinoStream, watchtowerTransport } from '../src/integrations/logs.js';

type Done = (r: { code: number }) => void;
interface LogRecordLike {
  severityText: string;
  body: string;
  attributes: Record<string, unknown>;
  spanContext: { traceId: string };
}

// the OTel global provider can be registered once per process: one init for the whole file
const spans: ReadableSpan[] = [];
const logs: LogRecordLike[] = [];
wt.init({
  apiKey: 'test-key-not-real',
  environment: 'staging',
  release: '1.2.3',
  captureProcessErrors: false,
  exporter: { export: (s: ReadableSpan[], done: Done) => { spans.push(...s); done({ code: 0 }); }, shutdown: async () => {}, forceFlush: async () => {} },
  logExporter: { export: (l: LogRecordLike[], done: Done) => { logs.push(...l); done({ code: 0 }); }, shutdown: async () => {}, forceFlush: async () => {} },
});

async function drain(): Promise<ReadableSpan[]> {
  await wt.flush();
  await new Promise((r) => setImmediate(r));
  return spans.splice(0);
}
const named = (all: ReadableSpan[], name: string): ReadableSpan => all.find((s) => s.name === name)!;

test('captureException records exception event and trace id, drops wt.*, dedupes', async () => {
  const err = new Error('boom');
  const tid = wt.captureException(err, { attributes: { 'wt.tenant_id': 'x', route: '/a' } });
  expect(tid).toMatch(/^[0-9a-f]{32}$/);
  expect(wt.captureException(err)).toBe(tid);
  const [s] = (await drain()) as [ReadableSpan];
  expect(s.name).toBe('exception');
  expect(s.spanContext().traceId).toBe(tid);
  expect(s.events.length).toBe(1);
  expect(s.events[0]!.attributes!['exception.message']).toBe('boom');
  expect(s.attributes.route).toBe('/a');
  expect(s.attributes['wt.tenant_id']).toBeUndefined();
  expect(s.attributes['error.handled']).toBe(true);
});

test('captureException on the active span reuses its trace', async () => {
  const f = wt.observe('op', () => wt.captureException('plain string'));
  const tid = f();
  const [s] = (await drain()) as [ReadableSpan];
  expect(s.name).toBe('op');
  expect(s.spanContext().traceId).toBe(tid);
  expect(s.events[0]!.attributes!['exception.message']).toBe('plain string');
});

test('resource carries environment and release from options', async () => {
  wt.observe('r', () => 1)();
  const [s] = (await drain()) as [ReadableSpan];
  expect(s.resource.attributes['deployment.environment.name']).toBe('staging');
  expect(s.resource.attributes['service.version']).toBe('1.2.3');
});

test('client never prints the key', () => {
  const c = new wt.Client({ apiKey: 'secret-key-value', exporter: { export() {}, shutdown: async () => {} } });
  expect(JSON.stringify(c)).not.toContain('secret-key-value');
  expect(inspect(c)).not.toContain('secret-key-value');
});

test('process handlers capture and exit only as sole listener', async () => {
  const proc = Object.assign(new EventEmitter(), { exit: (c: number) => proc.emit('exited', c) });
  const off = installProcessHandlers(async () => {}, proc as unknown as ProcessLike);
  const exited = new Promise((r) => proc.once('exited', r));
  const orig = console.error;
  console.error = () => {};
  proc.emit('uncaughtException', new Error('fatal-1'));
  expect(await exited).toBe(1);
  console.error = orig;
  expect((await drain())[0]!.attributes['error.mechanism']).toBe('uncaughtException');

  // another listener present: capture, but do not exit
  let didExit = false;
  proc.exit = () => { didExit = true; return true; };
  proc.on('unhandledRejection', () => {});
  proc.emit('unhandledRejection', new Error('rej'));
  await new Promise((r) => setImmediate(r));
  expect(didExit).toBe(false);
  expect((await drain())[0]!.attributes['error.mechanism']).toBe('unhandledRejection');
  off();
  expect(proc.listenerCount('uncaughtException')).toBe(0);
});

test('express: route-named span, 5xx captured, 4xx not', async () => {
  const req: ExpressRequest = { method: 'GET', originalUrl: '/u/1?token=abc', baseUrl: '/api', route: { path: '/u/:id' } };
  const res = Object.assign(new EventEmitter(), { statusCode: 200 }) as unknown as ExpressResponse & EventEmitter;
  let active;
  requestHandler()(req, res, () => { active = trace.getActiveSpan(); });
  expect(active).toBeTruthy();
  res.emit('finish');
  res.emit('close');
  errorHandler()(Object.assign(new Error('bad'), { status: 400 }), req, res, () => {});
  const err500 = new Error('server');
  let passed;
  errorHandler()(err500, req, res, (e) => { passed = e; });
  expect(passed).toBe(err500);
  const all = await drain();
  const s = named(all, 'GET /api/u/:id');
  expect(s).toBeTruthy();
  expect(s.attributes['url.path']).toBe('/u/1');
  expect(s.attributes['http.response.status_code']).toBe(200);
  expect(all.filter((x) => x.name === 'exception').length).toBe(1);
});

test('koa: error captured on the request trace and rethrown', async () => {
  const ctx = { method: 'POST', path: '/p', status: 404, _matchedRoute: '/p' };
  await expect(middleware()(ctx, async () => { throw new Error('koa-fail'); })).rejects.toThrow(/koa-fail/);
  const s = named(await drain(), 'POST /p');
  expect(s.attributes['http.response.status_code']).toBe(500);
  expect(s.events[0]!.attributes!['exception.message']).toBe('koa-fail');
});

test('fastify: hooks produce a span and capture 5xx', async () => {
  expect((plugin as unknown as Record<symbol, unknown>)[Symbol.for('skip-override')]).toBe(true);
  const hooks: Record<string, (...a: any[]) => void> = {};
  plugin({ addHook: (n, f) => { hooks[n] = f; } }, {}, () => {});
  const req = { method: 'GET', url: '/f?x=1', routeOptions: { url: '/f' } };
  hooks.onRequest!(req, {}, () => {});
  hooks.onError!(req, {}, new Error('fastify-fail'), () => {});
  hooks.onResponse!(req, { statusCode: 500 }, () => {});
  const all = await drain();
  const s = named(all, 'GET /f');
  expect(s).toBeTruthy();
  expect(s.attributes['http.route']).toBe('/f');
  expect(named(all, 'exception')).toBeTruthy();
});

test('koa and fastify capture redacted bodies only when a rule matches', async () => {
  setCaptureRules([{ route: '/login', body_bytes: 200 }]);
  try {
    const ctx = { method: 'POST', path: '/login', status: 200, _matchedRoute: '/login',
      request: { type: 'application/json', body: { user: 'u', password: 'hunter2' } },
      response: { type: 'application/json' }, body: { ok: true, email: 'a@b.io' } };
    await middleware()(ctx, async () => {});
    const hooks: Record<string, (...a: any[]) => void> = {};
    plugin({ addHook: (n, f) => { hooks[n] = f; } }, {}, () => {});
    const reply = { statusCode: 200, getHeader: () => 'application/json; charset=utf-8' };
    const req = { method: 'POST', url: '/login?x=1', routeOptions: { url: '/login' },
      headers: { 'content-type': 'application/json' }, body: { token: 'abc123' } };
    hooks.onRequest!(req, reply, () => {});
    let sent: unknown;
    hooks.onSend!(req, reply, '{"id":7}', (_e: null, p: unknown) => { sent = p; });
    expect(sent).toBe('{"id":7}');
    hooks.onResponse!(req, reply, () => {});
    const health = { ...ctx, path: '/health', _matchedRoute: '/health' };
    await middleware()(health, async () => {});
    const drained = await drain();
    const all = drained.filter((x) => x.name === 'POST /login');
    expect(all).toHaveLength(2);
    for (const s of all) {
      expect(String(s.attributes['http.request.body'])).toContain('[REDACTED]');
      expect(String(s.attributes['http.request.body'])).not.toMatch(/hunter2|abc123/);
    }
    expect(all.map((s) => s.attributes['http.response.body'])).toContain('{"id":7}');
    expect(all.map((s) => s.attributes['http.response.body'])).toContain('{"ok":true,"email":"[REDACTED]"}');
    expect(named(drained, 'POST /health').attributes['http.request.body']).toBeUndefined();
  } finally {
    setCaptureRules([]);
  }
});

test('nestjs interceptor captures 5xx with handler names and re-emits the error', async () => {
  interface Sub { next(v: unknown): void; error(e: unknown): void; complete(): void }
  class Obs {
    constructor(private fn: (sub: Sub) => unknown) {}
    subscribe(o: Sub) { return this.fn({ next: (v) => o.next(v), error: (e) => o.error(e), complete: () => o.complete() }); }
    pipe(op: (o: Obs) => Obs) { return op(this); }
  }
  class UsersController { get() {} }
  const execCtx = { getClass: () => UsersController, getHandler: () => UsersController.prototype.get };
  const failing = new Obs((sub) => sub.error(new Error('nest-fail')));
  const out = new WatchtowerInterceptor().intercept(execCtx, { handle: () => failing });
  const seen = await new Promise<Error>((resolve) => out.subscribe({ error: resolve }));
  expect(seen.message).toBe('nest-fail');
  const [s] = (await drain()) as [ReadableSpan];
  expect(s.attributes['code.namespace']).toBe('UsersController');
  expect(s.attributes['code.function']).toBe('get');
  // 4xx HttpException is not captured
  const notFound = new Obs((sub) => sub.error(Object.assign(new Error('nf'), { getStatus: () => 404 })));
  await new Promise((resolve) => new WatchtowerInterceptor().intercept(execCtx, { handle: () => notFound }).subscribe({ error: resolve }));
  expect((await drain()).length).toBe(0);
});

test('next: onRequestError captures route attributes without the query string', async () => {
  await onRequestError(new Error('render'), { method: 'GET', path: '/blog?draft=1' }, { routePath: '/blog', routerKind: 'App Router' });
  const [s] = (await drain()) as [ReadableSpan];
  expect(s.attributes['url.path']).toBe('/blog');
  expect(s.attributes['http.route']).toBe('/blog');
});

test('next: register is a no-op without a key', async () => {
  const saved = process.env.WT_INGEST_KEY;
  delete process.env.WT_INGEST_KEY;
  await register();
  if (saved) process.env.WT_INGEST_KEY = saved;
});

test('prisma extension wraps operations and records errors', async () => {
  const ext = watchtowerExtension() as { query: { $allModels: { $allOperations: (a: unknown) => Promise<unknown> } } };
  const op = ext.query.$allModels.$allOperations;
  expect(await op({ model: 'User', operation: 'findMany', args: {}, query: async () => [1] })).toStrictEqual([1]);
  await expect(op({ model: 'User', operation: 'create', args: {}, query: async () => { throw new Error('db'); } })).rejects.toThrow(/db/);
  const all = await drain();
  expect(named(all, 'prisma User.findMany').attributes['db.operation.name']).toBe('findMany');
  expect(named(all, 'prisma User.create').status.code).toBe(2);
});

test('lambda wrapper returns, captures errors and flushes', async () => {
  const ctx = { functionName: 'fn', awsRequestId: 'r1' };
  expect(await wrapHandler(async (e: { v: number }) => e.v)({ v: 7 }, ctx)).toBe(7);
  await expect(wrapHandler(async () => { throw new Error('lam'); })({}, ctx)).rejects.toThrow(/lam/);
  const all = await drain();
  expect(all.filter((s) => s.name === 'fn').length).toBe(2);
  expect(all.some((s) => s.events.some((e) => e.attributes!['exception.message'] === 'lam'))).toBe(true);
});

test('azure functions wrapper records cold start once, trigger, invocation id, 5xx and errors', async () => {
  const ctx = { functionName: 'az', invocationId: 'i1', options: { trigger: { type: 'httpTrigger' } } };
  expect(await wrapFunction(async () => ({ status: 200 }))({}, ctx)).toEqual({ status: 200 });
  await wrapFunction(async () => ({ status: 503 }))({}, { ...ctx, invocationId: 'i2' });
  await expect(wrapFunction(async () => { throw new Error('azf'); })({}, { ...ctx, invocationId: 'i3' })).rejects.toThrow(/azf/);
  const drained = await drain();
  const all = drained.filter((s) => s.name === 'az');
  expect(all.map((s) => s.attributes['faas.coldstart'])).toEqual([true, false, false]);
  expect(all[0]!.attributes['faas.trigger']).toBe('http');
  expect(all[0]!.attributes['faas.invocation_id']).toBe('i1');
  expect(all[1]!.attributes['http.response.status_code']).toBe(503);
  expect(all.map((s) => s.status.code)).toEqual([0, 2, 2]);
  expect(drained.some((s) => s.events.some((e) => e.attributes!['exception.message'] === 'azf'))).toBe(true);
  expect([faasTrigger('timerTrigger'), faasTrigger('serviceBusTrigger'), faasTrigger('blobTrigger'), faasTrigger(undefined)])
    .toEqual(['timer', 'pubsub', 'datasource', 'other']);
});

test('genai: openai and anthropic spans use GenAI semconv and keep the original promise', async () => {
  const reply = { id: 'c1', model: 'gpt-4o', choices: [{ finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 4 } };
  const original = Promise.resolve(reply);
  const openai = instrumentOpenAI({ chat: { completions: { create: (_b: unknown) => original } } });
  expect(openai.chat.completions.create({ model: 'gpt-4o', max_tokens: 9 })).toBe(original);
  const anthropic = instrumentAnthropic({
    messages: { create: async (_b: unknown) => ({ id: 'm1', model: 'claude-x', stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 6 } }) },
  });
  await anthropic.messages.create({ model: 'claude-x' });
  await expect(instrumentAnthropic({ messages: { create: async (_b: unknown) => { throw new Error('429'); } } }).messages.create({ model: 'm' })).rejects.toThrow(/429/);
  const all = await drain();
  const o = named(all, 'chat gpt-4o');
  expect(o.attributes['gen_ai.system']).toBe('openai');
  expect(o.attributes['gen_ai.usage.input_tokens']).toBe(3);
  expect(o.attributes['gen_ai.request.max_tokens']).toBe(9);
  expect(o.attributes['gen_ai.response.finish_reasons']).toStrictEqual(['stop']);
  const a = named(all, 'chat claude-x');
  expect(a.attributes['gen_ai.usage.output_tokens']).toBe(6);
  expect(named(all, 'chat m').status.code).toBe(2);
});

test('genai: bedrock converse, google genai and a litellm gateway', async () => {
  class ConverseCommand { constructor(public input: unknown) {} }
  class ListFoundationModelsCommand { constructor(public input: unknown) {} }
  const bedrock = instrumentBedrock({
    send: async function (this: { region: string }, _c: unknown) {
      return { $metadata: { requestId: this.region }, stopReason: 'end_turn', usage: { inputTokens: 8, outputTokens: 2 } };
    },
    region: 'rq-1',
  });
  await bedrock.send(new ConverseCommand({ modelId: 'anthropic.claude-3', inferenceConfig: { maxTokens: 64 }, messages: [{ content: 'secret' }] }));
  await bedrock.send(new ListFoundationModelsCommand({}));
  const google = instrumentGoogleGenAI({
    models: { generateContent: async (_b: unknown) => ({ responseId: 'g1', modelVersion: 'gemini-2.0-flash-001', usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 9 }, candidates: [{ finishReason: 'STOP' }] }) },
  });
  await google.models.generateContent({ model: 'gemini-2.0-flash', contents: 'hi', config: { maxOutputTokens: 100 } });
  const lite = instrumentOpenAI({ chat: { completions: { create: async (_b: unknown) => ({ id: 'l1', usage: { prompt_tokens: 1, completion_tokens: 1 } }) } } }, 'litellm');
  await lite.chat.completions.create({ model: 'openai/gpt-4o-mini' });
  const all = await drain();
  const b = named(all, 'chat anthropic.claude-3');
  expect(b.attributes['gen_ai.system']).toBe('aws.bedrock');
  expect(b.attributes['gen_ai.usage.input_tokens']).toBe(8);
  expect(b.attributes['gen_ai.request.max_tokens']).toBe(64);
  expect(b.attributes['gen_ai.response.id']).toBe('rq-1');
  expect(JSON.stringify(b.attributes)).not.toContain('secret');
  expect(all.filter((s) => s.attributes['gen_ai.system'] === 'aws.bedrock')).toHaveLength(1);
  const g = named(all, 'chat gemini-2.0-flash');
  expect([g.attributes['gen_ai.system'], g.attributes['gen_ai.usage.output_tokens'], g.attributes['gen_ai.request.max_tokens']]).toStrictEqual(['gemini', 9, 100]);
  expect(g.attributes['gen_ai.response.finish_reasons']).toStrictEqual(['STOP']);
  expect(named(all, 'chat openai/gpt-4o-mini').attributes['gen_ai.system']).toBe('litellm');
});

test('vercel ai telemetry defaults to no content', () => {
  const t = vercelAiTelemetry({ functionId: 'f' });
  expect([t.isEnabled, t.recordInputs, t.recordOutputs, t.functionId]).toStrictEqual([true, false, false, 'f']);
});

test('logs: pino stream and winston transport emit OTLP logs with trace ids', async () => {
  const pino = pinoStream();
  wt.observe('with-logs', () => {
    pino.write(JSON.stringify({ level: 50, time: 1, pid: 1, hostname: 'h', msg: 'bad thing', user: { id: 1 }, 'wt.tenant_id': 'x' }));
    (watchtowerTransport() as { log(i: object, cb: () => void): void }).log({ level: 'warn', message: 'careful', extra: 1 }, () => {});
  })();
  pino.write('not json'); // ignored
  const [span] = (await drain()) as [ReadableSpan];
  const [p, w] = logs.splice(0) as [LogRecordLike, LogRecordLike];
  expect(p.severityText).toBe('ERROR');
  expect(p.body).toBe('bad thing');
  expect(p.attributes.user).toBe('{"id":1}');
  expect(p.attributes['wt.tenant_id']).toBeUndefined();
  expect(p.spanContext.traceId).toBe(span.spanContext().traceId);
  expect(w.severityText).toBe('WARN');
  expect(w.attributes.extra).toBe(1);
});

const streamOf = (chunks: unknown[]) => ({
  async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; },
});

test('genai: streams keep the span open and record ttft, usage and tool calls', async () => {
  const chunks = [
    { id: 's1', model: 'gpt-4o', choices: [{ delta: { tool_calls: [{ id: 't1', function: { name: 'get_weather', arguments: '{"city":"secret"}' } }] } }] },
    { id: 's1', model: 'gpt-4o', choices: [{ finish_reason: 'tool_calls', delta: {} }] },
    { id: 's1', model: 'gpt-4o', choices: [], usage: { prompt_tokens: 7, completion_tokens: 2 } },
  ];
  const stream = streamOf(chunks);
  const openai = instrumentOpenAI({ chat: { completions: { create: async (_b: unknown) => stream } } });
  const got = await openai.chat.completions.create({ model: 'gpt-4o', stream: true });
  expect(got).toBe(stream);
  expect((await drain()).filter((x) => x.name === 'chat gpt-4o')).toHaveLength(0);
  let n = 0;
  for await (const _c of got as AsyncIterable<unknown>) n++;
  expect(n).toBe(3);
  const sp = named(await drain(), 'chat gpt-4o');
  expect(sp.attributes['gen_ai.usage.input_tokens']).toBe(7);
  expect(sp.attributes['gen_ai.response.finish_reasons']).toStrictEqual(['tool_calls']);
  expect(typeof sp.attributes['gen_ai.response.time_to_first_chunk']).toBe('number');
  expect(sp.events.map((e) => [e.name, e.attributes])).toStrictEqual([['gen_ai.tool.call', { 'gen_ai.tool.name': 'get_weather', 'gen_ai.tool.call.id': 't1' }]]);
  expect(JSON.stringify(sp.events)).not.toContain('secret');
});

test('genai: mistral (camelCase, chat.stream) and ollama (counts, tool calls)', async () => {
  const mistral = instrumentMistral({
    chat: {
      complete: async (_b: unknown) => ({ id: 'm1', model: 'mistral-large-latest', usage: { promptTokens: 4, completionTokens: 6 }, choices: [{ finishReason: 'stop', message: { toolCalls: [{ id: 'c', function: { name: 'lookup' } }] } }] }),
      stream: async (_b: unknown) => streamOf([{ data: { id: 'm2', model: 'mistral-small', choices: [{ finishReason: 'stop', delta: {} }], usage: { promptTokens: 1, completionTokens: 2 } } }]),
    },
  });
  await mistral.chat.complete({ model: 'mistral-large-latest', maxTokens: 50 });
  for await (const _c of (await mistral.chat.stream({ model: 'mistral-small' })) as AsyncIterable<unknown>) { /* drain */ }
  const ollama = instrumentOllama({
    chat: async (_b: unknown) => ({ model: 'llama3.2', prompt_eval_count: 12, eval_count: 8, done_reason: 'stop', message: { content: 'secret', tool_calls: [{ function: { name: 'add', arguments: { a: 1 } } }] } }),
    generate: async (_b: unknown) => ({ model: 'llama3.2', eval_count: 1 }),
  });
  await ollama.chat({ model: 'llama3.2', messages: [] });
  const all = await drain();
  const m = named(all, 'chat mistral-large-latest');
  expect([m.attributes['gen_ai.system'], m.attributes['gen_ai.usage.output_tokens'], m.attributes['gen_ai.request.max_tokens']]).toStrictEqual(['mistral_ai', 6, 50]);
  expect(m.events[0]!.attributes!['gen_ai.tool.name']).toBe('lookup');
  expect(named(all, 'chat mistral-small').attributes['gen_ai.usage.input_tokens']).toBe(1);
  const o = named(all, 'chat llama3.2');
  expect([o.attributes['gen_ai.system'], o.attributes['gen_ai.usage.input_tokens'], o.attributes['gen_ai.usage.output_tokens']]).toStrictEqual(['ollama', 12, 8]);
  expect(o.events.map((e) => e.attributes!['gen_ai.tool.name'])).toStrictEqual(['add']);
  expect(JSON.stringify(o.attributes)).not.toContain('secret');
});

test('genai: llamaindex callback events and the openai agents processor', async () => {
  const handlers = new Map<string, (e: { detail?: unknown }) => void>();
  instrumentLlamaIndex({ callbackManager: { on: (ev: string, h: (e: { detail?: unknown }) => void) => handlers.set(ev, h) } });
  handlers.get('llm-start')!({ detail: { id: 'l1' } });
  handlers.get('llm-end')!({ detail: { id: 'l1', response: { raw: { model: 'gpt-4o-mini', usage: { prompt_tokens: 3, completion_tokens: 4 } }, message: { options: { toolCall: [{ id: 'x', name: 'calc' }] } } } } });
  handlers.get('llm-tool-call')!({ detail: { toolCall: { name: 'calc', input: { a: 1 } } } });
  const p = instrumentOpenAIAgents(() => {});
  await p.onSpanStart({ spanId: 'a', spanData: { type: 'agent', name: 'triage' } });
  await p.onSpanStart({ spanId: 'g', parentId: 'a', spanData: { type: 'generation', model: 'gpt-4.1' } });
  await p.onSpanEnd({ spanId: 'g', parentId: 'a', spanData: { type: 'generation', model: 'gpt-4.1', usage: { input_tokens: 10, output_tokens: 5 } } });
  await p.onSpanStart({ spanId: 'f', parentId: 'a', spanData: { type: 'function', name: 'refund' } });
  await p.onSpanEnd({ spanId: 'f', parentId: 'a', spanData: { type: 'function', name: 'refund' }, error: { message: 'denied' } });
  await p.onSpanEnd({ spanId: 'a', spanData: { type: 'agent', name: 'triage' } });
  const all = await drain();
  const l = named(all, 'chat gpt-4o-mini');
  expect([l.attributes['gen_ai.system'], l.attributes['gen_ai.usage.output_tokens']]).toStrictEqual(['llama_index', 4]);
  expect(l.events[0]!.attributes!['gen_ai.tool.name']).toBe('calc');
  expect(named(all, 'execute_tool calc').attributes['gen_ai.operation.name']).toBe('execute_tool');
  const a = named(all, 'invoke_agent triage'), g = named(all, 'chat gpt-4.1'), f = named(all, 'execute_tool refund');
  expect(a.attributes['gen_ai.agent.name']).toBe('triage');
  expect(g.attributes['gen_ai.usage.input_tokens']).toBe(10);
  expect(g.parentSpanContext?.spanId).toBe(a.spanContext().spanId);
  expect(f.status.code).toBe(2);
});
