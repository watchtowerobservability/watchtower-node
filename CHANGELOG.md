# Changelog

## Unreleased

## 0.6.0

- Fix: the ESM build was unimportable (`dist/esm/load.js` lacked `need`). The ESM loader is now the compiled `load.ts` with a `createRequire`; `npm run smoke` packs, installs and imports both builds.
- Bundling: OpenTelemetry peers are required by literal name inside try blocks, so webpack, esbuild and Next's file tracer can follow them. README has a Next.js recipe.
- `redact` now also runs on span names (`span.name`), status messages (`status.message`), every span event's and link's attributes (including `exception.message` / `exception.stacktrace`) and log bodies (`log.body`). `@watchtowerobservability/node/next` exports `makeRegister(options)`; `register` is unchanged.
- `init` no longer disables the OpenTelemetry globals: it registers only those not yet set (a warning says when one was kept) and tears down only what an earlier `init` installed.
- Passing `exporter` no longer turns off the default log and metric exporters (use `logs: false` / `metrics: false`); an explicit `logExporter` / `metricExporter` turns its signal on and logs always go through a batch processor.
- Auto-instrumentation: `instrument` option (default on) for installed `@opentelemetry/instrumentation-{http,undici,pg,ioredis}` optional peers, and a `@watchtowerobservability/node/register` preload entry.
- `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SERVICE_NAME` and `OTEL_RESOURCE_ATTRIBUTES` are read after the `WT_*` variables; `service.version` from `OTEL_RESOURCE_ATTRIBUTES` is the release.
- README: npm install instructions (no token, no tarball).

## 0.5.0

- `@opentelemetry/api` is now the only hard dependency. The SDK packages (`sdk-trace`, `sdk-logs`, `sdk-metrics`, `resources`, `core`, `context-async-hooks`, `otlp-transformer` and the three OTLP/HTTP exporters) are optional peer dependencies, loaded when `init` runs; if one is missing, `init` throws an error that lists what to `npm install`. Install them next to the SDK (see the README). Same ranges as before (SDK 3.1, exporters 0.301).

- OpenTelemetry moves to the current majors: API 1.10, SDK packages 3.1 (`sdk-trace`, `sdk-metrics`, `sdk-logs`, `resources`, `core`) and the 0.301 exporters, replacing the 1.30 / 0.57 stack. Node 22.15 or newer is required (the OTel 3.x packages need it). `NodeTracerProvider` is gone upstream, so `init` registers the async-hooks context manager, the W3C propagators and the tracer provider itself; `Client.provider` is now an SDK `TracerProvider` and `Client.resource` is new. A span's parent is `parentSpanContext?.spanId` (was `parentSpanId`). The optional peer `@opentelemetry/instrumentation-runtime-node` is `>=0.38`.

- Datastores and queues: new subpaths `sql` (shared SQL normalizer and `db.query.hash`, same as the server), `sqlite` (node:sqlite, better-sqlite3, sqlite3, libSQL), `duckdb`, `lmdb`, `level` (LevelDB/RocksDB), `cache` (node-cache, lru-cache, Keyv hit/miss), `pools` (MongoDB, mysql2, any pool), `orm` (Drizzle, Kysely, TypeORM, Sequelize, MikroORM), `amqp` (amqplib, rabbitmq-client), `nats`, `mqtt`, `pg-boss`, `graphile-worker`. SQL spans carry an N+1 hint (`db.n_plus_one`, `db.query.repeat_count`); statement text is opt-in (`queryText` / `WATCHTOWER_DB_QUERY_TEXT=1`) and literal-free. postgres.js spans gain `db.query.hash`; `querySummary` also returns `target`.
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
