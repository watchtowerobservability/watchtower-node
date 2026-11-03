// Response, chunk and stream reading shared by every GenAI wrapper: tokens, finish reasons and tool calls
// from OpenAI, Anthropic, Mistral (camelCase) and Ollama shapes. Tool calls become `gen_ai.tool.call` span
// events with the tool name and call id only; prompt, completion and argument text is never recorded.
import { SpanStatusCode } from '@opentelemetry/api';
import type { Span } from '@opentelemetry/api';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' ? (v as Obj) : undefined);
const num = (...v: unknown[]): number | undefined => v.find((x): x is number => typeof x === 'number');
const str = (...v: unknown[]): string | undefined => v.find((x): x is string => typeof x === 'string' && x !== '');
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export interface Extract { id?: string; model?: string; input?: number; output?: number; reasons: string[]; tools: [string, string | undefined][] }

function toolsOf(calls: unknown, out: Extract['tools']): void {
  for (const tc of list(calls)) {
    const t = obj(tc);
    const name = str(obj(t?.function)?.name);
    if (name) out.push([name, str(t?.id)]);
  }
}

/** Reads a full response, a stream chunk or a stream event (`{ data }` for Mistral, typed events for Anthropic). */
export function extract(raw: unknown): Extract {
  let o = obj(raw) ?? {};
  if (o.choices === undefined && o.type === undefined && obj(o.data)) o = obj(o.data)!;
  const start = o.type === 'message_start' ? obj(o.message) : undefined;
  const u = obj(o.usage) ?? obj(start?.usage) ?? {};
  const g = obj(o.usageMetadata) ?? {};
  const x: Extract = {
    id: str(o.id, start?.id, o.responseId),
    model: str(o.model, start?.model, o.modelVersion),
    input: num(u.input_tokens, u.prompt_tokens, u.promptTokens, u.inputTokens, o.prompt_eval_count, g.promptTokenCount),
    output: num(u.output_tokens, u.completion_tokens, u.completionTokens, u.outputTokens, o.eval_count, g.candidatesTokenCount),
    reasons: [],
    tools: [],
  };
  for (const ch of list(o.choices)) {
    const c = obj(ch);
    const r = str(c?.finish_reason, c?.finishReason);
    if (r) x.reasons.push(r);
    const m = obj(c?.message) ?? obj(c?.delta);
    toolsOf(m?.tool_calls ?? m?.toolCalls, x.tools);
  }
  for (const r of [o.stop_reason, obj(o.delta)?.stop_reason, o.done_reason, o.stopReason]) if (str(r)) x.reasons.push(r as string);
  for (const b of list(o.content)) if (obj(b)?.type === 'tool_use') x.tools.push([String(obj(b)!.name), str(obj(b)!.id)]);
  const cb = obj(o.content_block);
  if (cb?.type === 'tool_use') x.tools.push([String(cb.name), str(cb.id)]);
  if (o.choices === undefined) toolsOf(obj(o.message)?.tool_calls, x.tools);
  return x;
}

/** Sets what `x` holds; `seen` keeps a stream's tool calls from repeating. */
export function applyExtract(span: Span, x: Extract, seen: Set<string> = new Set()): void {
  if (x.id) span.setAttribute('gen_ai.response.id', x.id);
  if (x.model) span.setAttribute('gen_ai.response.model', x.model);
  if (x.input != null) span.setAttribute('gen_ai.usage.input_tokens', x.input);
  if (x.output != null) span.setAttribute('gen_ai.usage.output_tokens', x.output);
  if (x.reasons.length) span.setAttribute('gen_ai.response.finish_reasons', x.reasons);
  for (const [name, id] of x.tools) {
    const k = `${name}\u0000${id ?? ''}`;
    if (seen.has(k)) continue;
    seen.add(k);
    span.addEvent('gen_ai.tool.call', { 'gen_ai.tool.name': name, ...(id ? { 'gen_ai.tool.call.id': id } : {}) });
  }
}

/**
 * Hooks the async iterator of a stream object in place (the caller keeps the SDK's own object): the span records
 * time to first chunk, usage, finish reasons and tool calls, and ends when the stream ends, fails or is closed.
 * False when `res` is not async iterable.
 */
export function tapStream(span: Span, res: unknown, startedMs: number): boolean {
  const s = obj(res) as (Obj & { [Symbol.asyncIterator]?: () => AsyncIterator<unknown> }) | undefined;
  const orig = s?.[Symbol.asyncIterator];
  if (!s || typeof orig !== 'function') return false;
  let first = true, done = false;
  const reasons: string[] = [], seen = new Set<string>();
  const end = (e?: unknown): void => {
    if (done) return;
    done = true;
    if (e !== undefined) {
      span.recordException(e as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (e as Error | undefined)?.message });
    }
    span.end();
  };
  s[Symbol.asyncIterator] = function (): AsyncIterator<unknown> {
    const inner = orig.call(s);
    return {
      async next(): Promise<IteratorResult<unknown>> {
        let r: IteratorResult<unknown>;
        try { r = await inner.next(); } catch (e) { end(e); throw e; }
        if (r.done) { end(); return r; }
        if (first) { first = false; span.setAttribute('gen_ai.response.time_to_first_chunk', (Date.now() - startedMs) / 1000); }
        const x = extract(r.value);
        for (const q of x.reasons) if (!reasons.includes(q)) reasons.push(q);
        applyExtract(span, { ...x, reasons }, seen);
        return r;
      },
      async return(v?: unknown): Promise<IteratorResult<unknown>> {
        end();
        return inner.return ? inner.return(v) : { done: true, value: v };
      },
    };
  };
  return true;
}
