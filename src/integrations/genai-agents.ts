// GenAI spans for frameworks with their own hooks: LlamaIndex.TS (callback manager events) and the OpenAI Agents
// SDK (trace processors). Agent runs become `invoke_agent` spans, model calls `chat` spans with usage, tool runs
// `execute_tool` spans with the tool name, nested as the framework nests them. No message, completion or tool
// argument text is recorded. Both take the framework's own object, so neither package is a dependency.
import { context, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import type { Attributes, Span } from '@opentelemetry/api';
import { applyExtract, extract } from './genai-stream.js';

type Obj = Record<string, unknown>;
export const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});
export const s = (v: unknown): string => (typeof v === 'string' ? v : '');

export function start(name: string, attrs: Attributes, parent?: Span, startTime?: number): Span {
  const ctx = parent ? trace.setSpan(context.active(), parent) : context.active();
  const clean = Object.fromEntries(Object.entries(attrs).filter(([, v]) => v !== undefined && v !== ''));
  return trace.getTracer('watchtower').startSpan(name, { kind: SpanKind.INTERNAL, attributes: clean, ...(startTime !== undefined ? { startTime } : {}) }, ctx);
}

/** The part of LlamaIndex.TS `Settings.callbackManager` used here. */
export interface CallbackManagerLike { on(event: string, handler: (e: { detail?: unknown }) => void): unknown }

/** instrumentLlamaIndex(Settings) (from `llamaindex`): llm-start/stream/end and tool call events as spans. */
export function instrumentLlamaIndex(settings: { callbackManager: CallbackManagerLike }): { open: Map<string, Span> } {
  const open = new Map<string, Span>(), t0 = new Map<string, number>();
  const cm = settings.callbackManager;
  cm.on('llm-start', (e) => {
    const id = s(obj(e.detail).id);
    open.set(id, start('chat', { 'gen_ai.operation.name': 'chat', 'gen_ai.system': 'llama_index' }));
    t0.set(id, Date.now());
  });
  cm.on('llm-stream', (e) => {
    const id = s(obj(e.detail).id), at = t0.get(id);
    if (at !== undefined) { t0.delete(id); open.get(id)?.setAttribute('gen_ai.response.time_to_first_chunk', (Date.now() - at) / 1000); }
  });
  cm.on('llm-end', (e) => {
    const d = obj(e.detail), id = s(d.id), span = open.get(id);
    if (!span) return;
    open.delete(id);
    t0.delete(id);
    const res = obj(d.response);
    const x = extract(res.raw);
    const msg = obj(res.message), opts = obj(msg.options);
    for (const tc of Array.isArray(opts.toolCall) ? opts.toolCall : []) {
      const name = s(obj(tc).name);
      if (name) x.tools.push([name, s(obj(tc).id) || undefined]);
    }
    if (x.model) span.updateName(`chat ${x.model}`);
    applyExtract(span, x);
    span.end();
  });
  cm.on('llm-tool-call', (e) => {
    const name = s(obj(obj(e.detail).toolCall).name);
    start(`execute_tool ${name}`.trim(), { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': name }).end();
  });
  return { open };
}

/** An OpenAI Agents SDK span as the trace processor sees it. */
interface AgentSpan { spanId?: string; parentId?: string | null; spanData?: Obj; error?: { message?: string } | null }

/** The processor `addTraceProcessor` takes (`@openai/agents`). */
export class AgentsProcessor {
  readonly open = new Map<string, Span>();
  async onTraceStart(): Promise<void> {}
  async onTraceEnd(): Promise<void> {}

  async onSpanStart(sp: AgentSpan): Promise<void> {
    const d = obj(sp.spanData), type = s(d.type), parent = sp.parentId ? this.open.get(sp.parentId) : undefined;
    let name = type || 'agents';
    let attrs: Attributes = {};
    if (type === 'agent') {
      name = `invoke_agent ${s(d.name)}`.trim();
      attrs = { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': s(d.name), 'gen_ai.system': 'openai' };
    } else if (type === 'generation' || type === 'response') {
      name = `chat ${s(d.model)}`.trim();
      attrs = { 'gen_ai.operation.name': 'chat', 'gen_ai.system': 'openai', 'gen_ai.request.model': s(d.model) };
    } else if (type === 'function') {
      name = `execute_tool ${s(d.name)}`.trim();
      attrs = { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': s(d.name) };
    } else if (type === 'handoff') {
      attrs = { 'gen_ai.operation.name': 'handoff', 'gen_ai.handoff.from_agent': s(d.from_agent), 'gen_ai.handoff.to_agent': s(d.to_agent) };
    } else if (type === 'guardrail') {
      name = `guardrail ${s(d.name)}`.trim();
      attrs = { 'gen_ai.guardrail.name': s(d.name) };
    }
    if (sp.spanId) this.open.set(sp.spanId, start(name, attrs, parent));
  }

  async onSpanEnd(sp: AgentSpan): Promise<void> {
    const span = sp.spanId ? this.open.get(sp.spanId) : undefined;
    if (!span || !sp.spanId) return;
    this.open.delete(sp.spanId);
    const d = obj(sp.spanData);
    if (d.type === 'generation') {
      const u = obj(d.usage);
      applyExtract(span, { model: s(d.model) || undefined, input: u.input_tokens as number | undefined, output: u.output_tokens as number | undefined, reasons: [], tools: [] });
    } else if (d.type === 'response') {
      applyExtract(span, extract(d._response ?? d.response));
    } else if (d.type === 'guardrail') {
      span.setAttribute('gen_ai.guardrail.triggered', Boolean(d.triggered));
    }
    if (sp.error) span.setStatus({ code: SpanStatusCode.ERROR, message: sp.error.message });
    span.end();
  }

  async shutdown(): Promise<void> {
    for (const span of this.open.values()) span.end();
    this.open.clear();
  }

  async forceFlush(): Promise<void> {}
}

/** instrumentOpenAIAgents(addTraceProcessor) with `addTraceProcessor` from `@openai/agents`; the SDK's own tracing keeps running. */
export function instrumentOpenAIAgents(addTraceProcessor: (p: AgentsProcessor) => void): AgentsProcessor {
  const p = new AgentsProcessor();
  addTraceProcessor(p);
  return p;
}
