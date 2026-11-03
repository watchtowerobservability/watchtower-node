// GenAI spans (OTel GenAI semconv) for the openai, anthropic, AWS Bedrock, Google GenAI, Mistral and Ollama SDKs (and
// LiteLLM through its OpenAI-compatible proxy), LlamaIndex and the OpenAI Agents SDK (genai-agents.ts), and a
// telemetry option for the Vercel AI SDK. Streams record time to first chunk, usage and tool calls (genai-stream.ts).
// Prompt and completion text is never recorded.
import { context, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import type { Span } from '@opentelemetry/api';
import { applyExtract, extract, tapStream } from './genai-stream.js';

export { instrumentLlamaIndex, instrumentOpenAIAgents } from './genai-agents.js';

const DONE = Symbol('wt.instrumented');

interface RequestBody { model?: string; max_tokens?: number | null; temperature?: number | null; stream?: boolean }
interface Usage { prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number; inputTokens?: number; outputTokens?: number }
interface Response {
  id?: string; model?: string; usage?: Usage; choices?: { finish_reason?: string }[]; stop_reason?: string;
  // Bedrock Converse
  stopReason?: string; $metadata?: { requestId?: string };
  // Google GenAI
  responseId?: string; modelVersion?: string; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  candidates?: { finishReason?: string }[];
}
/** Reads the model and options from the call's first argument. */
type Req = (arg: unknown) => RequestBody;
const plain: Req = (b) => (b || {}) as RequestBody;
type Method = ((this: unknown, ...a: unknown[]) => unknown) & { [DONE]?: boolean };
type Target = Record<string, Method | undefined>;

function wrap(target: Target | undefined, method: string, system: string, req: Req = plain): void {
  if (!target || typeof target[method] !== 'function' || target[method]![DONE]) return;
  const orig = target[method]!;
  const wrapped: Method = function (this: unknown, body?: unknown, ...rest: unknown[]) {
    const b = req(body);
    const started = Date.now();
    const span = trace.getTracer('watchtower').startSpan(`chat ${b.model || ''}`.trim(), {
      kind: SpanKind.CLIENT,
      attributes: {
        'gen_ai.operation.name': 'chat',
        'gen_ai.system': system,
        ...(b.model ? { 'gen_ai.request.model': b.model } : {}),
        ...(b.max_tokens != null ? { 'gen_ai.request.max_tokens': b.max_tokens } : {}),
        ...(b.temperature != null ? { 'gen_ai.request.temperature': b.temperature } : {}),
      },
    });
    const p = context.with(trace.setSpan(context.active(), span), () => orig.call(this, body, ...rest));
    // side branch only: the caller keeps the SDK's own promise (APIPromise helpers stay intact)
    Promise.resolve(p).then(
      (res) => {
        // a stream keeps the span open until it ends (this runs before the caller's own continuation)
        if (b.stream && tapStream(span, res, started)) return;
        // the shared reader adds camelCase usage (Mistral), Ollama counts and tool calls
        if (!b.stream && res) { record(span, res as Response); applyExtract(span, extract(res)); }
        span.end();
      },
      (e: unknown) => {
        span.recordException(e as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: (e as Error | undefined)?.message });
        span.end();
      });
    return p;
  };
  wrapped[DONE] = true;
  target[method] = wrapped;
}

function record(span: Span, res: Response): void {
  const u = res.usage || {};
  const g = res.usageMetadata || {};
  const input = u.prompt_tokens ?? u.input_tokens ?? u.inputTokens ?? g.promptTokenCount;
  const output = u.completion_tokens ?? u.output_tokens ?? u.outputTokens ?? g.candidatesTokenCount;
  const one = res.stop_reason ?? res.stopReason;
  const finish = Array.isArray(res.choices) ? res.choices.map((c) => c.finish_reason)
    : Array.isArray(res.candidates) ? res.candidates.map((c) => c.finishReason) : one ? [one] : [];
  const id = res.id ?? res.responseId ?? res.$metadata?.requestId;
  const model = res.model ?? res.modelVersion;
  if (id) span.setAttribute('gen_ai.response.id', id);
  if (model) span.setAttribute('gen_ai.response.model', model);
  if (finish.length) span.setAttribute('gen_ai.response.finish_reasons', finish.filter((f): f is string => Boolean(f)));
  if (input != null) span.setAttribute('gen_ai.usage.input_tokens', input);
  if (output != null) span.setAttribute('gen_ai.usage.output_tokens', output);
}

/**
 * instrumentOpenAI(new OpenAI()): chat.completions.create and responses.create. Returns the client.
 * For an OpenAI-compatible gateway pass its name: instrumentOpenAI(new OpenAI({ baseURL: litellmUrl }), 'litellm').
 */
export function instrumentOpenAI<T>(client: T, system = 'openai'): T {
  const c = client as { chat?: { completions?: Target }; responses?: Target };
  wrap(c.chat && c.chat.completions, 'create', system);
  wrap(c.responses, 'create', system);
  return client;
}

/** instrumentBedrock(new BedrockRuntimeClient()): `send` of Converse and InvokeModel commands; others pass through untraced. */
export function instrumentBedrock<T>(client: T): T {
  const c = client as unknown as Target;
  const send = c.send;
  if (typeof send !== 'function' || send[DONE]) return client;
  const traced: Target = { send };
  wrap(traced, 'send', 'aws.bedrock', (cmd) => {
    const x = (cmd || {}) as { constructor?: { name?: string }; input?: { modelId?: string; inferenceConfig?: { maxTokens?: number; temperature?: number } } };
    const name = (x.constructor && x.constructor.name) || '';
    return { model: x.input?.modelId, max_tokens: x.input?.inferenceConfig?.maxTokens, temperature: x.input?.inferenceConfig?.temperature, stream: name.includes('Stream') };
  });
  const wrapped: Method = function (this: unknown, cmd?: unknown, ...rest: unknown[]) {
    const name = ((cmd as { constructor?: { name?: string } } | undefined)?.constructor?.name) || '';
    return /^(Converse|InvokeModel)/.test(name) ? traced.send!.call(this, cmd, ...rest) : send.call(this, cmd, ...rest);
  };
  wrapped[DONE] = true;
  c.send = wrapped;
  return client;
}

/** instrumentGoogleGenAI(new GoogleGenAI({...})): models.generateContent (Gemini API or Vertex AI). */
export function instrumentGoogleGenAI<T>(client: T): T {
  const c = client as { models?: Target; vertexai?: boolean };
  wrap(c.models, 'generateContent', c.vertexai ? 'vertex_ai' : 'gemini', (b) => {
    const x = (b || {}) as { model?: string; config?: { maxOutputTokens?: number; temperature?: number } };
    return { model: x.model, max_tokens: x.config?.maxOutputTokens, temperature: x.config?.temperature };
  });
  return client;
}

/** instrumentAnthropic(new Anthropic()): messages.create. Returns the client. */
export function instrumentAnthropic<T>(client: T): T {
  wrap((client as { messages?: Target }).messages, 'create', 'anthropic');
  return client;
}

/** instrumentMistral(new Mistral()): chat.complete and chat.stream (the stream span ends with the stream). */
export function instrumentMistral<T>(client: T): T {
  const c = (client as { chat?: Target }).chat;
  wrap(c, 'complete', 'mistral_ai', mistralReq);
  wrap(c, 'stream', 'mistral_ai', (b) => ({ ...mistralReq(b), stream: true }));
  return client;
}

const mistralReq: Req = (b) => {
  const x = (b || {}) as { model?: string; maxTokens?: number; temperature?: number };
  return { model: x.model, max_tokens: x.maxTokens, temperature: x.temperature };
};

/** instrumentOllama(new Ollama()) or instrumentOllama(ollama): chat and generate, with `stream: true` too. */
export function instrumentOllama<T>(client: T): T {
  const ollamaReq: Req = (b) => {
    const x = (b || {}) as { model?: string; stream?: boolean; options?: { num_predict?: number; temperature?: number } };
    return { model: x.model, stream: x.stream, max_tokens: x.options?.num_predict, temperature: x.options?.temperature };
  };
  wrap(client as unknown as Target, 'chat', 'ollama', ollamaReq);
  wrap(client as unknown as Target, 'generate', 'ollama', ollamaReq);
  return client;
}

/** generateText({ ..., experimental_telemetry: vercelAiTelemetry() }); inputs/outputs off unless overridden. */
export function vercelAiTelemetry(o?: Record<string, unknown>): Record<string, unknown> {
  return { isEnabled: true, recordInputs: false, recordOutputs: false, tracer: trace.getTracer('watchtower'), ...o };
}
