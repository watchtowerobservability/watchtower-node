'use strict';
// GenAI spans (OTel GenAI semconv) for the openai and anthropic SDKs, and a telemetry option for the Vercel AI SDK.
// Prompt and completion text is never recorded.
const { context, SpanKind, SpanStatusCode, trace } = require('@opentelemetry/api');

const DONE = Symbol('wt.instrumented');

function wrap(target, method, system) {
  if (!target || typeof target[method] !== 'function' || target[method][DONE]) return;
  const orig = target[method];
  const wrapped = function (body, ...rest) {
    const b = body || {};
    const span = trace.getTracer('watchtower').startSpan(`chat ${b.model || ''}`.trim(), {
      kind: SpanKind.CLIENT,
      attributes: {
        'gen_ai.operation.name': 'chat',
        'gen_ai.system': system,
        ...(b.model && { 'gen_ai.request.model': b.model }),
        ...(b.max_tokens != null && { 'gen_ai.request.max_tokens': b.max_tokens }),
        ...(b.temperature != null && { 'gen_ai.request.temperature': b.temperature }),
      },
    });
    const p = context.with(trace.setSpan(context.active(), span), () => orig.call(this, body, ...rest));
    // side branch only: the caller keeps the SDK's own promise (APIPromise helpers stay intact)
    Promise.resolve(p).then(
      (res) => {
        // shortcut: a stream ends the span at creation, without token usage; wrap the iterator to record it
        if (!b.stream && res) record(span, res);
        span.end();
      },
      (e) => {
        span.recordException(e);
        span.setStatus({ code: SpanStatusCode.ERROR, message: e && e.message });
        span.end();
      });
    return p;
  };
  wrapped[DONE] = true;
  target[method] = wrapped;
}

function record(span, res) {
  const u = res.usage || {};
  const input = u.prompt_tokens != null ? u.prompt_tokens : u.input_tokens;
  const output = u.completion_tokens != null ? u.completion_tokens : u.output_tokens;
  const finish = Array.isArray(res.choices) ? res.choices.map((c) => c.finish_reason) : res.stop_reason ? [res.stop_reason] : [];
  if (res.id) span.setAttribute('gen_ai.response.id', res.id);
  if (res.model) span.setAttribute('gen_ai.response.model', res.model);
  if (finish.length) span.setAttribute('gen_ai.response.finish_reasons', finish.filter(Boolean));
  if (input != null) span.setAttribute('gen_ai.usage.input_tokens', input);
  if (output != null) span.setAttribute('gen_ai.usage.output_tokens', output);
}

/** instrumentOpenAI(new OpenAI()): chat.completions.create and responses.create. Returns the client. */
function instrumentOpenAI(client) {
  wrap(client.chat && client.chat.completions, 'create', 'openai');
  wrap(client.responses, 'create', 'openai');
  return client;
}

/** instrumentAnthropic(new Anthropic()): messages.create. Returns the client. */
function instrumentAnthropic(client) {
  wrap(client.messages, 'create', 'anthropic');
  return client;
}

/** generateText({ ..., experimental_telemetry: vercelAiTelemetry() }); inputs/outputs off unless overridden. */
function vercelAiTelemetry(o) {
  return { isEnabled: true, recordInputs: false, recordOutputs: false, tracer: trace.getTracer('watchtower'), ...o };
}

module.exports = { instrumentOpenAI, instrumentAnthropic, vercelAiTelemetry };
