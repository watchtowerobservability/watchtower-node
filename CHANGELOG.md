# Changelog

## Unreleased

- Metrics: the OTel metrics SDK with a periodic OTLP reader (delta temporality by default), set as the global meter provider by `init`; runtime metrics through the optional peer `@opentelemetry/instrumentation-runtime-node`; spooled to `bufferDir/metrics`. `WATCHTOWER_LOGS` / `WATCHTOWER_METRICS` (or `logs` / `metrics` options) switch the two signals, default on.

- GenAI: `instrumentMistral`, `instrumentOllama`, `instrumentLlamaIndex(Settings)` and `instrumentOpenAIAgents(addTraceProcessor)`. Streams (`stream: true`, Mistral `chat.stream`) keep the span open until the stream ends and record time to first chunk, usage and finish reasons; tool calls become `gen_ai.tool.call` span events (name and id only) for every wrapper.
- Offline buffer: log records are spooled too. `bufferDir` now holds `traces/` and `logs/` subdirectories (at most 500 batches each, oldest dropped, replayed oldest first before the next export); batches spooled by older versions in the root of `bufferDir` are not replayed.
- GenAI: `instrumentBedrock` (Converse/InvokeModel via `send`), `instrumentGoogleGenAI` (`models.generateContent`, Gemini or Vertex AI) and a gateway name for `instrumentOpenAI(client, 'litellm')`.

## 0.2.0

- TypeScript source with generated type declarations; dual ESM and CommonJS build (`dist/esm`, `dist/cjs`).
- No API change: same exports, subpaths, options, environment variables and behavior.
- New: the `jest` and `vitest` reporter subpaths now ship types.

## 0.1.0

- Init over the OpenTelemetry Node SDK: key header, `WT_OTLP_ENDPOINT`, offline buffer, redaction hook.
- Configuration from `WT_INGEST_KEY`, `WT_SERVICE`, `WT_ENVIRONMENT`, `WT_RELEASE`.
- Error capture: `captureException`, `uncaughtException` and `unhandledRejection` hooks, trace ids returned.
- OTLP logs (`log`) with pino and winston bridges.
- Integrations: express, fastify, koa, nestjs, next.js (instrumentation hook), prisma, AWS Lambda wrapper,
  openai, anthropic and Vercel AI SDK GenAI spans.
- Jest and Vitest reporters, prompts, scores, evals.
- The key is masked in `console.log` and `JSON.stringify` output of the client.
