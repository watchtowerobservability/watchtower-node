# Changelog

## 0.1.0

- Init over the OpenTelemetry Node SDK: key header, `WT_OTLP_ENDPOINT`, offline buffer, redaction hook.
- Configuration from `WT_INGEST_KEY`, `WT_SERVICE`, `WT_ENVIRONMENT`, `WT_RELEASE`.
- Error capture: `captureException`, `uncaughtException` and `unhandledRejection` hooks, trace ids returned.
- OTLP logs (`log`) with pino and winston bridges.
- Integrations: express, fastify, koa, nestjs, next.js (instrumentation hook), prisma, AWS Lambda wrapper,
  openai, anthropic and Vercel AI SDK GenAI spans.
- Jest and Vitest reporters, prompts, scores, evals.
- The key is masked in `console.log` and `JSON.stringify` output of the client.
