# @watchtowerobservability/node

[![CI](https://github.com/watchtowerobservability/watchtower-node/actions/workflows/ci.yml/badge.svg)](https://github.com/watchtowerobservability/watchtower-node/actions/workflows/ci.yml)

## Install

Published on npm:

```sh
npm install @watchtowerobservability/node @opentelemetry/context-async-hooks @opentelemetry/core \
  @opentelemetry/exporter-logs-otlp-http @opentelemetry/exporter-metrics-otlp-http @opentelemetry/exporter-trace-otlp-http \
  @opentelemetry/otlp-transformer @opentelemetry/resources @opentelemetry/sdk-logs @opentelemetry/sdk-metrics @opentelemetry/sdk-trace
```

`@opentelemetry/api` is the only hard dependency; the OpenTelemetry SDK packages above are optional peers (so your app controls their versions) and are loaded by `init`, which throws an error naming the missing ones.

Optional auto-instrumentation peers (installed ones are used, see below):
`npm install @opentelemetry/instrumentation @opentelemetry/instrumentation-http @opentelemetry/instrumentation-undici @opentelemetry/instrumentation-pg @opentelemetry/instrumentation-ioredis`.

Written in TypeScript and shipped as both ESM and CommonJS (`import` and `require` both work); the `.d.ts`
typings are generated from the source. A thin layer over the OpenTelemetry Node SDK (ruling L1): `Authorization: Bearer` header, endpoint default (`WT_OTLP_ENDPOINT`), disk offline buffer,
`wt.*`-safe resource attributes, redaction hook, `getPrompt`, `score`, `evaluate`, `observe`.

```ts
import * as wt from '@watchtowerobservability/node';   // or: const wt = require('@watchtowerobservability/node');
wt.init({ apiKey: process.env.WT_INGEST_KEY, project: process.env.WT_PROJECT_ID, bufferDir: '.wt-buffer' });
```

## Quick start

```ts
import * as wt from '@watchtowerobservability/node';   // or: const wt = require('@watchtowerobservability/node');
wt.init({});                                   // WT_INGEST_KEY, WT_SERVICE, WT_ENVIRONMENT, WT_RELEASE from env
const traceId = wt.captureException(new Error('oops')); // also: uncaught errors and unhandled rejections
wt.log('info', 'started', { port: 3000 });     // OTLP log, linked to the active trace
```

`init` hooks `uncaughtException` and `unhandledRejection` (pass `captureProcessErrors: false` to opt out). It
flushes and exits with code 1 like Node does, only when no other handler is registered.
Request bodies, headers, query strings and query arguments are never recorded.

## Auto-instrumentation and preload

`init` patches `node:http`, `fetch` (undici), `pg` and `ioredis` for each `@opentelemetry/instrumentation-*` package you have installed (the list above); pass `instrument: false` or set `WT_INSTRUMENT=0` to skip. Patching only reaches modules loaded after it runs, so load the SDK first:

```sh
node --require @watchtowerobservability/node/register app.js     # CommonJS app (also: node -r ...)
node --import @watchtowerobservability/node/register app.mjs     # ESM app
```

`register` calls `init({})` when `WT_INGEST_KEY` is set. For an ESM app it also registers OpenTelemetry's ESM loader hook (`@opentelemetry/instrumentation/hook.mjs`, resolved from your project, so install `@opentelemetry/instrumentation`) so `node:http` and other ES-module imports get patched; no extra flag is needed. The CommonJS and ESM copies of this package share one client (kept on `globalThis`), so `flush()` and `shutdown()` work from either. Start a CommonJS app with `--require` and an ES-module app with `--import`.

`init` registers the global tracer provider, context manager, propagator and meter provider only when none is registered yet (OpenTelemetry allows each once): call `init` before other OTel setup. It no longer disables globals set earlier; a warning (via the OTel `diag` logger) says when one was kept. A second `init` replaces only what the first one installed.

## Next.js

```ts
// instrumentation.ts
import { makeRegister } from '@watchtowerobservability/node/next';
export const register = makeRegister({ redact: (k, v) => v });   // any InitOptions; plain `register` takes env only
export { onRequestError } from '@watchtowerobservability/node/next';
```

Install the OpenTelemetry peers above in the app itself (with pnpm, as direct dependencies, so Next's standalone tracer copies them). The SDK requires each peer by its literal name, so webpack and Next's file tracer can follow them; if the SDK arrives through a transpiled workspace package, add it to `transpilePackages`. Add `outputFileTracingIncludes` for the peers only if the standalone build still reports a missing `@opentelemetry/*` package.

Bundling with esbuild or webpack (ESM or CommonJS output) works: both the CommonJS and ESM builds name every optional peer with a literal `require`/`import()` inside try, so the bundler follows the peers you have installed and skips the rest.

## Integrations

Each lives at its own subpath, so nothing is loaded that you do not import.

| Integration | Import | Use |
| --- | --- | --- |
| Express | `@watchtowerobservability/node/express` | `app.use(requestHandler())` first, `app.use(errorHandler())` last |
| Fastify | `.../fastify` | `await app.register(plugin)` |
| Koa | `.../koa` | `app.use(middleware())` first |
| NestJS | `.../nestjs` | `app.useGlobalInterceptors(new WatchtowerInterceptor())` (add express or fastify integration for spans) |
| Next.js server | `.../next` | `instrumentation.js`: `module.exports = require('@watchtowerobservability/node/next')` (exports `register`, `onRequestError`) |
| Prisma | `.../prisma` | `prisma.$extends(watchtowerExtension())` |
| BullMQ | `.../bullmq` | `import * as bullmq from 'bullmq'; instrumentBullMQ(bullmq)` before creating queues and workers |
| postgres.js (>= 4) | `.../postgres` | `instrumentPostgres()` once at startup |
| SQLite (`node:sqlite`) | `.../sqlite` | `import * as sqlite from 'node:sqlite'; instrumentNodeSqlite(sqlite)` |
| better-sqlite3 | `.../sqlite` | `instrumentBetterSqlite3(Database)` (the default export) |
| sqlite3 | `.../sqlite` | `instrumentSqlite3(sqlite3)` |
| libSQL / Turso | `.../sqlite` | `const db = instrumentLibsql(createClient({ url }))` |
| DuckDB | `.../duckdb` | `import * as duckdb from '@duckdb/node-api'; instrumentDuckDB(duckdb)` (classic `duckdb` too) |
| LMDB (lmdb-js) | `.../lmdb` | `instrumentLmdb(open({ path }))` after `init` |
| LevelDB / RocksDB | `.../level` | `instrumentLevel(new ClassicLevel(dir))`, `instrumentLevel(rocksdb(dir), { system: 'rocksdb' })` |
| node-cache, lru-cache, Keyv | `.../cache` | `instrumentNodeCache(cache, 'sessions')`, `instrumentLruCache(lru)`, `instrumentKeyv(keyv)` after `init` |
| MongoDB pool | `.../pools` | `instrumentMongoPool(client)` after `init` (pool gauges, wait/use time, timeouts from CMAP events) |
| mysql2 pool | `.../pools` | `instrumentMysql2Pool(pool)` (callback or `.promise()` pool) |
| Any pool (e.g. node-postgres) | `.../pools` | `observePool('postgresql', 'main', () => ({ used: p.totalCount - p.idleCount, idle: p.idleCount, pending: p.waitingCount, max: 10 }))` |
| Drizzle | `.../orm` | `instrumentDrizzle(db, 'postgresql')` once per `drizzle(...)` instance |
| Kysely | `.../orm` | `new Kysely({ dialect, log: kyselyLog('postgresql') })` |
| TypeORM | `.../orm` | `instrumentTypeORM(dataSource)` |
| Sequelize | `.../orm` | `new Sequelize(url, { benchmark: true, logging: sequelizeLogging('postgresql') })` |
| MikroORM | `.../orm` | `MikroORM.init({ loggerFactory: mikroOrmLoggerFactory(DefaultLogger, 'postgresql') })` |
| amqplib (RabbitMQ) | `.../amqp` | `instrumentAmqplib(await conn.createChannel())` once (patches the channel class) |
| rabbitmq-client | `.../amqp` | `instrumentRabbitmqClient(rabbit)` before `createPublisher`/`createConsumer` |
| NATS (nats.js) | `.../nats` | `import * as nats from 'nats'; instrumentNats(nc, nats)` |
| MQTT (mqtt.js) | `.../mqtt` | `instrumentMqtt(client)` (context propagates on MQTT 5 clients) |
| pg-boss | `.../pg-boss` | `instrumentPgBoss(boss)` before `send`/`work` |
| Graphile Worker | `.../graphile-worker` | `run({ taskList: wrapTaskList(tasks) })`; `instrumentAddJob(utils)` |
| kafkajs | upstream | use `@opentelemetry/instrumentation-kafkajs` |
| SQL normalizer | `.../sql` | `normalizeAndHash(sql)` -> `[literal-free text, db.query.hash]` |
| AWS Lambda | `.../lambda` | `exports.handler = wrapHandler(async (event, ctx) => ...)` (async handlers; flushes before freeze) |
| Azure Functions | `.../azure-functions` | `app.http('fn', { handler: wrapFunction(async (req, ctx) => ...) })` (cold start, trigger, invocation id; flushes) |
| pino | `.../logs` | `pino(opts, pinoStream())` |
| winston | `.../logs` | `logger.add(watchtowerTransport())` |
| openai | `.../genai` | `instrumentOpenAI(new OpenAI())` |
| anthropic | `.../genai` | `instrumentAnthropic(new Anthropic())` |
| Mistral, Ollama | `.../genai` | `instrumentMistral(new Mistral())`, `instrumentOllama(ollama)` |
| LlamaIndex.TS | `.../genai` | `instrumentLlamaIndex(Settings)` |
| OpenAI Agents SDK | `.../genai` | `instrumentOpenAIAgents(addTraceProcessor)` |
| LangChain.js / LangGraph.js | `.../genai` | `graph.invoke(x, { callbacks: [langchainCallbackHandler()] })` |
| Vercel AI SDK agent loop | `.../genai` | `const { generateText } = instrumentVercelAI({ generateText })` |
| Mastra | `.../genai` | `instrumentMastra(agent)` |
| Vercel AI SDK (telemetry only) | `.../genai` | `generateText({ experimental_telemetry: vercelAiTelemetry() })` |

GenAI spans follow the OTel GenAI semantic conventions (model, token usage, finish reasons); prompt and
completion text is not recorded. Streaming calls end their span at creation, without token usage.

### BullMQ

`instrumentBullMQ(bullmq)` patches the module you pass, so it works the same under ESM and CommonJS.
`Queue.add` and `addBulk` get PRODUCER spans (`send <queue>`); each job a `Worker` runs gets a
CONSUMER span (`process <queue>`) whose parent is the producer span, so one trace runs from the
request that queued the job to the job itself. The context travels in the job data under `_wt`
(object data only) and is removed before your processor sees `job.data`. Attributes follow the OTel
messaging conventions: `messaging.system=bullmq`, `messaging.destination.name`,
`messaging.operation.type` (`send`/`process`), `messaging.operation.name`, `messaging.message.id`,
`messaging.batch.message_count`, `messaging.bullmq.job.attempt` and `messaging.bullmq.job.delay_ms`.
Sandboxed processors (a file path instead of a function) run in a child process and get no consumer
span.

### postgres.js

postgres.js has no OTel instrumentation; from 4.0 it publishes every query on the `postgres:query`
diagnostics tracing channel. `instrumentPostgres()` subscribes to it and records a CLIENT span per
query, child of the active span: `db.system=postgresql`, `db.operation.name`, `db.namespace`,
`server.address`/`server.port`, `db.query.summary` (operation and first table, e.g.
`SELECT users`) and `db.query.hash` (see below; the statement text and parameters are never recorded).
A failed query sets the span
to error with its SQLSTATE in `db.response.status_code` (the error message is not recorded: it can
quote values). It returns an unsubscribe function.

### Datastore spans: summary, hash, N+1

Every datastore integration below (and postgres.js) records a CLIENT span per call, child of the
active span, following the OTel database conventions: `db.system.name`, `db.operation.name`,
`db.collection.name`, `db.namespace` and, for SQL, `db.query.summary` (also the span name, e.g.
`SELECT users`) and `db.query.hash`. The hash comes from the shared SQL normalizer (literals become
`?`, comments go, `IN (1, 2, 3)` becomes `IN (?+)`), so it is the same hash Watchtower computes on the
server and spans join the Datastores views. The algorithm is specified in
`docs/product/instrumentation/sql-normalization.md` and exported at `.../sql`.

Statement text and parameters are never recorded by default. Pass `{ queryText: true }` (or set
`WATCHTOWER_DB_QUERY_TEXT=1`) to add `db.query.text`, which is then the literal-free text. A
statement that runs more than 5 times under one parent span gets `db.n_plus_one=true` and
`db.query.repeat_count` from the sixth run on; change the limit with `{ nPlusOne: n }` or
`WATCHTOWER_DB_N_PLUS_ONE` (0 turns it off). Failed calls set the span to error with the driver's
code in `db.response.status_code` and `error.type`; the error message is not recorded (it can quote
values). All integrations take the module, class or instance you pass, so they work under ESM and
CommonJS. Metric helpers use the global meter: call them after `init`.

### Embedded stores and caches

- **SQLite.** `instrumentNodeSqlite`, `instrumentBetterSqlite3` and `instrumentSqlite3` trace `exec`
  and prepared `run`/`get`/`all` (sqlite3: `run`/`get`/`all`/`exec`/`each` on `Database`; the span
  ends in your callback, which keeps the caller's context). `instrumentLibsql(client)` traces
  `execute`, `executeMultiple`, `batch` and the same calls on transactions. `observeSqliteFile(path)`
  reports `wt.embedded.file.size` and `wt.embedded.wal.size`. Not traced: `iterate()`, sqlite3
  `Statement` objects.
- **DuckDB.** `instrumentDuckDB(duckdb)` traces `DuckDBConnection.run*`/`stream*` (Neo API) or the
  classic `Database`/`Connection` callbacks; `observeDuckDBFile(path)` reports file and WAL size.
  Prepared statements are not traced.
- **LMDB.** `instrumentLmdb(db)` traces async writes (`put`, `remove`, `ifVersion`, `ifNoExists`,
  `clearAsync`, `drop`), `getMany` and `transaction` (calls inside it are child spans), on the root
  and on `openDB` sub-databases. Synchronous `get` is memory-mapped and gets no span. It reports
  `wt.embedded.map.size`, `.map.used`, `.entries`, `.readers` and `.file.size`.
- **LevelDB / RocksDB.** `instrumentLevel(db, { system })` traces `get`, `getMany`, `put`, `del`,
  `batch` and `clear` (promise or callback form) on the db and its sublevels, and reports the store
  directory size as `wt.embedded.file.size`. Iterators and the chained `batch()` builder are not
  traced.
- **Caches.** `instrumentNodeCache`, `instrumentLruCache` and `instrumentKeyv` count
  `wt.embedded.cache.hits` and `.misses` (a `get` returning `undefined` is a miss; multi-key gets count
  per key) and, where the cache knows it, `wt.embedded.cache.entries`. Caches get metrics, not
  spans.

### Connection pools

Pool metrics follow the OTel database conventions and carry `db.system.name` and
`db.client.connection.pool.name`: `db.client.connection.count{db.client.connection.state=used|idle}`,
`db.client.connection.max`, `db.client.connection.pending_requests`, the histograms
`db.client.connection.wait_time` and `db.client.connection.use_time` (seconds) and the counter
`db.client.connection.timeouts`. Call these after `init`; the gauges are read at each export.
`instrumentMongoPool(client)` builds them per server address from the driver's connection-pool
events (wait time needs driver 6.9 or newer). `instrumentMysql2Pool(pool)` reads the pool's own
counts and measures use time from acquire to release. It is named `host:port/database` unless you
pass a name. mysql2 reports no queue wait and has no acquire timeout, so those two stay empty.
For any other pool, `observePool(system, name, read)` takes your own `read()` function. It returns
`wait(s)`, `use(s)`, `timeout()` and `stop()`.

### ORMs

Each ORM query becomes a CLIENT span with the summary, hash and N+1 hint described above.
- **Drizzle and TypeORM:** the query runs inside the span. Drizzle transactions run on their own
  session and get no spans.
- **Kysely, Sequelize and MikroORM:** the span is built from the query time the ORM reports and
  ends when the query does. Sequelize needs `benchmark: true` and does not report failed queries
  with a timing.
- **TypeORM:** maps `options.type` to the OTel names (postgres to postgresql, mssql to
  microsoft.sql_server, the sqlite drivers to sqlite).

If you also instrument the driver underneath, each query gets one ORM span and one driver span.

### Queues and brokers

Every broker and job-queue integration records a PRODUCER span when a message or job is sent and a
CONSUMER span when it is processed. The consumer span is a child of the producer span and also links
to it, so one trace runs from the request to the handler and Watchtower can compute queue lag
(`wt.messaging.lag_ms`). Attributes follow the OTel messaging conventions: `messaging.system`,
`messaging.destination.name`, `messaging.operation.type` (`send`/`process`), `messaging.operation.name`,
`messaging.message.id`, `messaging.message.body.size`, `messaging.batch.message_count` and
`messaging.consumer.group.name` where the library has one. A failed handler marks its span as an error
with `error.type`; the error message is not recorded.

- **amqplib**: `publish` and `sendToQueue` put `traceparent`/`tracestate` into `options.headers`
  (your headers are kept); `consume` callbacks run in the consumer span. Also recorded:
  `messaging.rabbitmq.destination.routing_key`, `messaging.rabbitmq.message.delivery_tag` and
  `.redelivered`. A ConfirmChannel is a separate class, so instrument one of those too if you use it.
- **rabbitmq-client**: `publisher.send(envelope | queue, body)` adds the context to the envelope
  headers; `createConsumer` handlers run in the consumer span.
- **nats**: `publish` and `request` add the context as NATS headers. A `callback` subscription runs
  each callback in the consumer span. With `for await (const m of sub)`, each message's span runs from
  receipt until the next iteration and is not active inside the loop body: spans you start there are
  not its children, but the producer link still gives lag.
- **mqtt**: `publish`/`publishAsync` carry the context in MQTT 5 user properties, so only
  `protocolVersion: 5` clients propagate it; older clients get spans that are not linked. `message`
  listeners run in the consumer span. `publish` spans end when the call returns; use `publishAsync`
  to include the QoS 1/2 ack time.
- **pg-boss**: `send` and `insert` (v9 and v10 forms) carry the context in job data under `_wt`
  (object data only). It is removed before your `work` handler runs. A batch gets one consumer span
  linked to every job's producer. `messaging.system` is `pg-boss`, since OTel defines no value for it.
  `sendAfter`, `sendThrottled`, `sendDebounced` and `sendSingleton` bypass `send`, so their jobs carry
  no context.
- **Graphile Worker**: `instrumentAddJob(utils)` (or the runner from `run`) adds `_wt` to the payload.
  `wrapTaskList` runs each task in a consumer span, strips `_wt`, and instruments `helpers.addJob` so
  follow-up jobs stay in the trace. `quickAddJob` cannot be patched under ESM; use `utils.addJob`.
- **kafkajs**: upstream `@opentelemetry/instrumentation-kafkajs` already covers it.

## Profiling

Set `WT_PROFILING=1` and `init()` starts the profiler with the same key, endpoint, service and
release as traces. Or start it yourself:

```ts
import { startProfiling } from '@watchtowerobservability/node/profiling';
await startProfiling({ service: 'api' }); // key and endpoint from WT_INGEST_KEY / WT_OTLP_ENDPOINT
```

V8's own CPU sampler (`node:inspector`, 100 Hz, no native addon) is encoded as pprof (no extra
dependency) and posted to the gateway's `/v1/profiles?format=pprof&service=<service>&version=<release>`
every 60 s. Idle time is left out. Samples taken inside `withSpan` carry `span_id` and `trace_id`
labels. `shutdown()` uploads the last partial period. `withSpan(() => work())`
labels samples with the active OpenTelemetry span, so a trace links to its exact profile. By default
only its synchronous part counts. `startProfiling({ asyncSpans: true })` (or
`enableAsyncSpanLabels()`) also labels code after each `await`, through AsyncLocalStorage and V8
promise hooks. It is opt-in because its overhead is not part of the benchmark below. Plain callbacks it starts
(timers, events) are labeled only from their own `await`s on. Past 100 000 labeled intervals in one
upload period, the rest of that period is unlabeled.

### Measuring profiler overhead

The profiler's CPU cost depends on your machine and workload, so measure it instead of trusting a
number: `WT_BENCH=1 npx vitest run test/overhead.bench.test.ts` (in `sdks/node`) runs a CPU-bound loop
with and without the 100 Hz sampler, prints the median overhead in percent and fails above
`WT_BENCH_MAX_PCT` (default 2). `WT_BENCH_ROUNDS` and `WT_BENCH_WORK_MS` tune the run. We publish no
measured figure here; run it on your hardware. The benchmark excludes the once-a-minute upload.

## App and API Protection

An in-app WAF fed by your project's ruleset (key scope `probes:read`). In `monitor` mode it
records attacks on the server span. In `block` mode, and always for denylisted IPs and users, it
answers 403 before your handler runs.

```ts
import { startAppsec, appsecMiddleware, trackLogin } from '@watchtowerobservability/node/appsec';
startAppsec(); // WT_API_URL, WT_INGEST_KEY, WT_SERVICE
app.use(appsecMiddleware());
// in the login handler: trackLogin(email, ok);
```

See `docs/product/security/app-api-protection.md`.

## Configuration

| Option | Env var | Default |
| --- | --- | --- |
| `apiKey` | `WT_INGEST_KEY` | required, sent as `Authorization: Bearer`, masked in output |
| `endpoint` | `WT_OTLP_ENDPOINT`, then `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` |
| `serviceName` | `WT_SERVICE`, then `OTEL_SERVICE_NAME` | `app` |
| `environment` | `WT_ENVIRONMENT` | unset |
| `release` | `WT_RELEASE`, then `service.version` in `OTEL_RESOURCE_ATTRIBUTES` | unset; sent as `service.version`, and an issue's first release is linked when a release with that version exists in the project |
| `resource` | `OTEL_RESOURCE_ATTRIBUTES` | none; `OTEL_EXPORTER_OTLP_HEADERS` adds extra headers, and its `Authorization=Bearer <key>` is used when `WT_INGEST_KEY` is unset |
| `instrument` | `WT_INSTRUMENT` | `on` for installed http / undici / pg / ioredis instrumentations |
| `bufferDir` | | no offline buffer (spans, logs and metrics spool to `traces/`, `logs/` and `metrics/`, 500 batches each) |
| `logs` | `WATCHTOWER_LOGS` (`OTEL_LOGS_EXPORTER=none` also turns it off) | `on`: OTLP logs (`log()`, pino, winston) |
| `metrics` | `WATCHTOWER_METRICS` (`OTEL_METRICS_EXPORTER=none` also turns it off) | `on`: OTLP metrics, see below |
| `redact` | | none; called for every span and log attribute, every span event's attributes (`exception.message`, `exception.stacktrace`), the span name (key `span.name`), the status message (`status.message`) and log bodies (`log.body`) |

Metrics: `init` sets the global meter provider, so `metrics.getMeter('app')` (re-exported from
`@opentelemetry/api`) records to Watchtower. A periodic reader exports to `/v1/metrics` every
`OTEL_METRIC_EXPORT_INTERVAL` ms (default 60000); counters and histograms use delta temporality unless
`OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE` is set. Install the optional peer
`@opentelemetry/instrumentation-runtime-node` for event loop, GC and heap metrics.

Examples: [`examples/basic.ts`](examples/basic.ts), [`examples/express-app`](examples/express-app/server.js).

Development: `npm install`, `npm run typecheck`, `npm test` (vitest), `npm run build` (`tsc` to `dist/cjs` and `dist/esm`).

## Test reporters and resumable evals

Jest: `reporters: ['default', ['@watchtowerobservability/node/jest', {}]]`. Vitest: `reporters: ['default', ['@watchtowerobservability/node/vitest', {}]]`.

Test optimization (`WT_TEST_OPTIMIZATION=1`, same contract as the pytest plugin: disabled and unaffected tests are skipped, quarantined failures do not fail the run, new tests are retried `efd_retries` times; `WT_CI_RUN_ID` also uploads the results as JUnit). Add a global setup file `export { default } from '@watchtowerobservability/node/test-plan'`, then for Vitest a setup file `import { beforeAll, afterEach } from 'vitest'; import { vitestSetup } from '@watchtowerobservability/node/test-plan'; vitestSetup({ beforeAll, afterEach });`, for Jest `testEnvironment: './wt-env.js'` with `module.exports = require('@watchtowerobservability/node/test-plan').jestEnvironment(require('jest-environment-node').TestEnvironment)`. Go: `go test -json ./... | wtctl ci gotest --respect-quarantine ...` and `go test -skip "$(wtctl ci plan ... --go-skip)"`.
Each test becomes a span (`test.outcome`) and, with `WT_PROJECT_ID`, a `test_pass` score. Set `WT_INGEST_KEY`
(or pass `client`/`apiKey`); without a key the reporters do nothing.

`client.evaluateResume(dataset, task, scorers, previousRows)` re-runs only the cases that errored or are missing
(the Python SDK has `evaluate_resume`).

## Provenance

Every release artifact carries a GitHub build attestation. Verify one with
`gh attestation verify <file> --repo watchtowerobservability/watchtower-node`.

## License

Apache-2.0. Source of truth is the Watchtower monorepo; this repository is a published mirror.
