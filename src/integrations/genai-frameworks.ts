// GenAI spans for the TypeScript agent frameworks: LangGraph.js (a LangChain.js callback handler), the Vercel AI SDK
// agent loop (generateText / streamText with several steps) and Mastra agents. Same shape as the Python
// instrumentors and `genai-agents.ts`: `invoke_agent` / `chat` / `execute_tool` spans, nested as the run nests,
// never any prompt, completion or tool argument text. CrewAI has no JavaScript port, so there is no CrewAI hook here.
// Nothing is imported from the frameworks: each function takes their object.
import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import type { Span } from '@opentelemetry/api';
import { obj, s, start } from './genai-agents.js';

type Fn = (...a: unknown[]) => unknown;
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const thenable = (v: unknown): v is PromiseLike<unknown> => !!v && typeof (v as { then?: unknown }).then === 'function';

function fail(span: Span, e: unknown): void {
  span.recordException(e as Error);
  span.setStatus({ code: SpanStatusCode.ERROR, message: (e as Error | undefined)?.message });
}

/**
 * langchainCallbackHandler(): pass it as `callbacks: [handler]` to a LangChain.js model, chain or LangGraph.js graph
 * (`graph.invoke(input, { callbacks: [handler] })`). LangGraph nodes (chains whose metadata names `langgraph_node`)
 * and the graph itself become `invoke_agent` spans, tools `execute_tool`, model calls `chat`, nested as they run;
 * plain LCEL chains get no span. Returns a plain handler object (LangChain wraps it) with the open spans for tests.
 */
export function langchainCallbackHandler(): Record<string, unknown> & { open: Map<string, Span> } {
  const open = new Map<string, Span>(), up = new Map<string, string | undefined>();
  const begin = (runId: string, parentId: string | undefined, name: string, attrs: Record<string, string | undefined>): void => {
    up.set(runId, parentId);
    let p = parentId;
    while (p !== undefined && !open.has(p)) p = up.get(p); // a parent without a span: skip to its own parent
    open.set(runId, start(name, attrs, p === undefined ? undefined : open.get(p)));
  };
  const close = (runId: string, error?: unknown): Span | undefined => {
    up.delete(runId);
    const span = open.get(runId);
    open.delete(runId);
    if (span && error !== undefined) fail(span, error);
    return span;
  };
  const llmStart = (extra: unknown, llm: unknown) => (runId: string, parentId?: string): void => {
    const p = obj(obj(extra).invocation_params), k = obj(obj(llm).kwargs);
    const model = s(p.model) || s(p.model_name) || s(k.model) || s(k.modelName);
    begin(runId, parentId, `chat ${model}`.trim(), { 'gen_ai.operation.name': 'chat', 'gen_ai.system': 'langchain', 'gen_ai.request.model': model });
  };
  const ender = (runId: string, error?: unknown): void => { close(runId, error)?.end(); };
  const h = {
    open,
    handleChatModelStart: (llm: unknown, _m: unknown, runId: string, parentId?: string, extra?: unknown) => llmStart(extra, llm)(runId, parentId),
    handleLLMStart: (llm: unknown, _p: unknown, runId: string, parentId?: string, extra?: unknown) => llmStart(extra, llm)(runId, parentId),
    handleLLMEnd: (output: unknown, runId: string): void => {
      const span = close(runId);
      if (!span) return;
      const o = obj(output), tu = obj(obj(o.llmOutput).tokenUsage);
      const first = Array.isArray(o.generations) && Array.isArray(o.generations[0]) ? obj((o.generations[0] as unknown[])[0]) : {};
      const msg = obj(first.message), um = obj(msg.usage_metadata), rm = obj(msg.response_metadata);
      const input = num(tu.promptTokens) ?? num(um.input_tokens), out = num(tu.completionTokens) ?? num(um.output_tokens);
      if (input !== undefined) span.setAttribute('gen_ai.usage.input_tokens', input);
      if (out !== undefined) span.setAttribute('gen_ai.usage.output_tokens', out);
      if (s(rm.model_name)) span.setAttribute('gen_ai.response.model', s(rm.model_name));
      if (s(rm.finish_reason)) span.setAttribute('gen_ai.response.finish_reasons', [s(rm.finish_reason)]);
      span.end();
    },
    handleLLMError: (e: unknown, runId: string): void => ender(runId, e),
    handleChainStart: (_c: unknown, _i: unknown, runId: string, parentId?: string, _t?: unknown, metadata?: unknown, _rt?: unknown, runName?: string): void => {
      const m = obj(metadata), node = s(m.langgraph_node);
      // only LangGraph runs get spans (the graph root and its nodes); plain LCEL chains are noise
      if (!node && !(parentId === undefined && m.langgraph_step !== undefined)) { up.set(runId, parentId); return; }
      const who = node && runName === node ? node : runName || node || 'graph';
      begin(runId, parentId, `invoke_agent ${who}`, { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': who, 'gen_ai.system': 'langgraph' });
    },
    handleChainEnd: (_o: unknown, runId: string): void => ender(runId),
    handleChainError: (e: unknown, runId: string): void => ender(runId, e),
    handleToolStart: (tool: unknown, _i: unknown, runId: string, parentId?: string, _t?: unknown, _m?: unknown, runName?: string): void => {
      const name = runName || s(obj(tool).name) || s(obj(obj(tool).kwargs).name);
      begin(runId, parentId, `execute_tool ${name}`.trim(), { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': name });
    },
    handleToolEnd: (_o: unknown, runId: string): void => ender(runId),
    handleToolError: (e: unknown, runId: string): void => ender(runId, e),
  };
  return h;
}

/** Wraps every `execute` of an AI SDK / Mastra tool set so each call is an `execute_tool` span under the agent run. */
function wrapTools(tools: unknown, root: Span): unknown {
  const out: Record<string, unknown> = {};
  for (const [name, t] of Object.entries(obj(tools))) {
    const tool = obj(t), exec = tool.execute;
    if (typeof exec !== 'function') { out[name] = t; continue; }
    out[name] = {
      ...tool,
      execute: (...a: unknown[]): unknown => {
        const sp = start(`execute_tool ${name}`, { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': name }, root);
        const done = (e?: unknown): void => { if (e !== undefined) fail(sp, e); sp.end(); };
        try {
          const r = (exec as Fn).apply(tool, a);
          if (thenable(r)) r.then(() => done(), (e: unknown) => done(e ?? new Error('tool failed')));
          else done();
          return r;
        } catch (e) { done(e); throw e; }
      },
    };
  }
  return out;
}

/**
 * One agent run as an `invoke_agent` span. `onStepFinish` (injected, the caller's own still runs) turns every model
 * step into a `chat` span with usage, timed from the previous step's end; tool `execute` calls become
 * `execute_tool` spans. `optsAt` is the position of the options argument. A stream ends the run in `onFinish` /
 * `onError`; a promise ends it when it settles.
 */
function agentRun(system: string, name: string, orig: Fn, self: unknown, args: unknown[], optsAt: number, stream: boolean): unknown {
  const root = start(`invoke_agent ${name}`.trim(), { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': name, 'gen_ai.system': system });
  let ended = false, last = Date.now();
  const end = (e?: unknown): void => { if (ended) return; ended = true; if (e !== undefined) fail(root, e); root.end(); };
  const opts: Record<string, unknown> = { ...obj(args[optsAt]) };
  const onStep = opts.onStepFinish as Fn | undefined, onFinish = opts.onFinish as Fn | undefined, onError = opts.onError as Fn | undefined;
  opts.onStepFinish = (e: unknown): unknown => {
    const d = obj(e), u = obj(d.usage), r = obj(d.response);
    const model = s(r.modelId) || s(r.model) || s(d.model);
    const sp = start(`chat ${model}`.trim(), { 'gen_ai.operation.name': 'chat', 'gen_ai.system': system, 'gen_ai.response.model': model }, root, last);
    const input = num(u.inputTokens) ?? num(u.promptTokens), out = num(u.outputTokens) ?? num(u.completionTokens);
    if (input !== undefined) sp.setAttribute('gen_ai.usage.input_tokens', input);
    if (out !== undefined) sp.setAttribute('gen_ai.usage.output_tokens', out);
    if (s(d.finishReason)) sp.setAttribute('gen_ai.response.finish_reasons', [s(d.finishReason)]);
    sp.end();
    last = Date.now();
    return onStep?.(e);
  };
  if (stream) {
    opts.onFinish = (e: unknown): unknown => { end(); return onFinish?.(e); };
    opts.onError = (e: unknown): unknown => { end(obj(e).error ?? e ?? new Error('stream failed')); return onError?.(e); };
  }
  if (opts.tools) opts.tools = wrapTools(opts.tools, root);
  const a = [...args];
  a[optsAt] = opts;
  let res: unknown;
  try {
    res = context.with(trace.setSpan(context.active(), root), () => orig.apply(self, a));
  } catch (e) { end(e); throw e; }
  if (!stream) {
    // side branch only: the caller keeps the framework's own promise
    if (thenable(res)) res.then(() => end(), (e: unknown) => end(e ?? new Error('run failed')));
    else end();
  }
  return res;
}

/**
 * instrumentVercelAI({ generateText, streamText }) with the functions from `ai`: returns wrapped copies (ES module
 * exports cannot be patched). Pass `agentName` to name the run (default: the `experimental_telemetry.functionId`, else `agent`).
 *   const { generateText } = instrumentVercelAI({ generateText: ai.generateText });
 * A multi-step loop (`maxSteps` / `stopWhen`) gives one `invoke_agent` span with a `chat` span per step and an
 * `execute_tool` span per tool call.
 */
export function instrumentVercelAI<T extends { generateText?: Fn; streamText?: Fn }>(ai: T, agentName?: string): T {
  const out: T = { ...ai };
  const nameOf = (a: unknown[]): string => agentName || s(obj(obj(a[0]).experimental_telemetry).functionId) || 'agent';
  if (typeof ai.generateText === 'function') {
    const f = ai.generateText;
    (out as { generateText?: Fn }).generateText = function (this: unknown, ...a: unknown[]) { return agentRun('vercel_ai', nameOf(a), f, this, a, 0, false); };
  }
  if (typeof ai.streamText === 'function') {
    const f = ai.streamText;
    (out as { streamText?: Fn }).streamText = function (this: unknown, ...a: unknown[]) { return agentRun('vercel_ai', nameOf(a), f, this, a, 0, true); };
  }
  return out;
}

/** instrumentMastra(agent): wraps `agent.generate` and `agent.stream` of a Mastra `Agent`; the run is named after the agent. Returns the agent. */
export function instrumentMastra<T>(agent: T): T {
  const a = agent as unknown as Record<string, unknown>;
  const name = s(a.name) || 'agent';
  for (const [method, stream] of [['generate', false], ['stream', true]] as const) {
    const f = a[method];
    if (typeof f !== 'function' || (f as { __wt?: boolean }).__wt) continue;
    const wrapped = function (this: unknown, ...args: unknown[]) { return agentRun('mastra', name, f as Fn, this, args, 1, stream); };
    (wrapped as { __wt?: boolean }).__wt = true;
    a[method] = wrapped;
  }
  return agent;
}
