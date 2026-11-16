# Changelog

## 0.7.8 (2026-11-16)

- Fix: on a non-cloud VM the OpenTelemetry resource detectors probed `169.254.169.254` and the 10 s timeout surfaced as a `UND_ERR_CONNECT_TIMEOUT` issue. When `OTEL_NODE_RESOURCE_DETECTORS` is unset, `init()` now sets it to `env,host,os,process`, adding `aws`, `gcp` or `azure` only when an environment variable shows that cloud (for example `AWS_REGION`, `K_SERVICE`, `WEBSITE_SITE_NAME`). Set `OTEL_NODE_RESOURCE_DETECTORS` yourself to override. Call `init()` (or use the `register` preload) before your own `NodeSDK` starts.
- The http and undici instrumentations ignore requests to cloud metadata endpoints (`169.254.169.254`, `169.254.170.2`, `metadata.google.internal`, `metadata.azure.internal`), so a failed probe is never reported as an error.

## 0.7.7 (2026-11-16)

- Quieter traces by default: `pg-pool.connect`, bare `BEGIN` / `COMMIT` / `ROLLBACK` statement spans and Express middleware layer spans (`middleware - *`, `expressInit`, `query`) are dropped before export; errored spans are always kept. `noisySpans: true` (or `WT_NOISY_SPANS=1`) keeps them. Your own `spanFilter` still runs on what is left.
- When the ingest endpoint refuses traces with HTTP 429 (the project's daily quota is spent), the SDK prints one `[watchtower] traces are being dropped: daily quota reached (...)` warning instead of failing silently. The server now answers with a body naming the quota and `Retry-After` until 00:00 UTC.
- `tunnelHandler` takes `otlpEndpoint` (base URL for `/v1/traces` and `/v1/logs`, default `endpoint`) and logs one warning when the upstream answers 404 for those paths. The edge now serves `/v1/traces` for publishable keys, so the documented single-endpoint tunnel works.

## 0.7.6 (2026-11-15)

- Next.js: `withWatchtower` now keeps every OpenTelemetry instrumentation package the SDK loads (`instrumentation-http`, `-undici`, `-runtime-node`, `-pg`, `-mysql2`, `-ioredis`) in `serverExternalPackages`. Bundled, they extended an undefined `InstrumentationBase` and a standalone build failed every request with `Class extends value undefined`. A test keeps the list in step with `package.json`.
- Next.js next to Sentry: when `@sentry/nextjs` or `@sentry/node` is in the app's `package.json` (or `sentry: true`), `withWatchtower` no longer externalises `@opentelemetry/api` and `@opentelemetry/instrumentation`. Sentry's nested OTel copies stay bundled and imported them; externalised, its bundled `HttpInstrumentation` extended `undefined` and every request failed in the instrumentation hook.

## 0.7.5 (2026-11-15)

- Telemetry that is off is now visible: the `register` preload prints `[watchtower] telemetry is OFF: <reason>` when `WT_INGEST_KEY` is unset or the SDK cannot start, and the first helper call that is dropped (`log`, `observe`, `checkin` ...) prints it once more with the reason.
- `tsx` / `ts-node`: the preload's ESM hook skips `.ts`/`.tsx` sources, which it used to re-parse as JavaScript, printing an `Error:` per file.
- The `register` preload and peer loader search the SDK location, then the cwd, then the entry script's directory (pnpm monorepos). README: use `node --import .../register`, not `NODE_OPTIONS=--import`.
- `log`, `observe`, `checkIn`, `checkin`, `withMonitor`, `getPrompt`, `score`, `evaluate` are no-ops before `init()` (no throw); `observe` and `withMonitor` still run the function.
- New `/temporal`: `temporalInterceptors()` (activity spans, final-attempt failure capture) and `watchTemporalSchedules(client)` (Schedule check-ins, slug `temporal-<scheduleId>`).
- New `/tunnel` subpath for `tunnelHandler` (framework-neutral); `/next` still re-exports it.

- Privacy: log bridges (`pinoStream`, `watchtowerTransport`) flatten nested objects into dotted attributes (`req.url`, `req.remoteAddress`, depth 4; arrays of primitives stay arrays, deeper values are JSON strings). `redact(key, value)` now also runs per leaf with the leaf name (after the dotted key), so a hook on `url` or `remoteAddress` fires and the `strict`/`pii` presets see the leaves; URL scrubbing applies to `*.url` / `*.uri` / `*.target` log attributes. Behavior change: `user: {id: 1}` is now `user.id` = 1, not the JSON string `user`.
- `init` logs one warning naming OpenTelemetry peers that cannot be loaded, with the Next standalone fix. New `wt-next-doctor [dir]` bin: reports SDK peers missing from `.next/standalone/node_modules` (npm and pnpm layouts), exit 1.
- `/fastify` plugin enriches the active http-instrumentation server span (name, `http.route`, status) instead of starting a second server span; without one it still makes its own.
- README: postgres.js >= 4, Fastify plugin with http instrumentation, `captureProcessErrors`, Next standalone recipe.

- Check-ins go to the edge host (`ingest.x` becomes `edge.x`; `WT_CHECKIN_URL` overrides) because the ingest gateway has no `/v1/checkins` route. They are fire and forget with a 5 s cap and never throw; `wt.checkin()` still awaits. New `checkIn(slug, status, { wait, durationMs })`.
- `withMonitor(slug, fn, { schedule, timezone, checkinMargin, maxRuntime, failureThreshold, wait })`: `in_progress`, then `ok`/`error` with the duration; the schedule goes in the check-in body as `monitor_config` so the server can create the monitor. Its own HTTP call is not traced.
- `instrumentNestSchedule(registry)` (`@nestjs/schedule` `@Cron` jobs) and `instrumentNodeCron(cron)` run each named job as a monitor.
- `instrumentBullMQ(bullmq, { captureFailures, cronMonitors })`: final-attempt failures become errors with queue, job name and id, attempt, attempts; repeatable jobs become cron monitors.
- `redact: 'strict' | 'pii' | 'off'` (default `'strict'`): secret-shaped attribute keys become `[redacted]` on spans, events, logs; `pii` also masks emails, phones, Luhn cards and IPs; `off` also disables URL scrubbing. A function still works and runs after the `strict` preset (behaviour change: `authorization`, `cookie`, `password`, `token` ... string attributes are now redacted by default).
- `otel: 'auto' | 'own' | 'attach'` (default `'auto'`): when another library (Sentry) already registered the global tracer provider, the exporter is attached to it as a span processor and our context manager and propagator are not installed.
- `init()` result carries `traces`, `metrics`, `logs`, `blocked`, `warnings` (type `InitStatus`).
- New `instrument(name)` for `nest`, `express`, `next`, `bullmq`, `pg`, `postgres`, `ioredis`. node:http server spans are renamed `METHOD /route/:param` from the matched Express/Nest route (`WT_ROUTE_NAMES=0` to opt out).
- Release also falls back to `WT_BUILD_STAMP` / `BUILD_STAMP`, then to the `.git/HEAD` commit found upward from the working directory (no child process).
- Counter `wt.sdk.db.dropped_spans` and a one-time warning when `requireParent` drops a datastore span; `droppedDbSpans()`.
- README: "Keys: which key goes where" table.

- `tunnelHandler` forwards the visitor's `Origin` and `Referer` (and `x-wt-sdk`, `x-wt-mask`) to the edge, so a browser key no longer gets 403 `origin_not_allowed` through the tunnel; add your site's origin to the key's allowed origins. A same-origin GET without `Origin` gets the `Referer`'s origin. New `allowKey` option (string or list): beacons whose `?k=` / `wtp_` bearer is not listed get 403.
- `withWatchtower(config, opts)` now makes `output: 'standalone'` work with no other config: the node SDK and its OpenTelemetry peers are added to `serverExternalPackages` and (npm and pnpm layouts) `outputFileTracingIncludes`; `NEXT_PUBLIC_WT_RELEASE` is set from `opts.release` or the CI git sha. `sourcemaps` also takes `{ upload: true, deleteAfterUpload: true, ... }`: the webpack client build uploads `.next/static/**/*.map` (bundle route, 429 honored) and deletes them. Turbopack: keep `wt-next-sourcemaps`.
- New subpath exports `@watchtowerobservability/node/next-build` and `/next-tunnel` (no SDK import; used by `@watchtowerobservability/next`).
- `service.version` also falls back to the first set of `GITHUB_SHA`, `CI_COMMIT_SHA`, `VERCEL_GIT_COMMIT_SHA`, `SOURCE_VERSION`, `BUILD_SHA`, `RENDER_GIT_COMMIT`, `HEROKU_SLUG_COMMIT` (after `release`, `WT_RELEASE` and `OTEL_RESOURCE_ATTRIBUTES`; empty and `unknown` are ignored).
- Behaviour change: datastore `requireParent` now defaults to true only when HTTP server instrumentation is active, so queue workers (BullMQ) record their queries as root spans. `WATCHTOWER_DB_REQUIRE_PARENT=0/1` still overrides.
- `instrumentPostgres()` logs one warning when `postgres` is installed but `diagnostics_channel.tracingChannel` is unavailable (needs `postgres@>=4`).

- `wt-next-sourcemaps` / `uploadSourcemaps()` send the maps in one `POST /v1/projects/{prj}/artifacts/bundle?release=` request per ~120 MB (tar.gz plus a manifest) instead of one request per map. A server without the bundle route is detected and the batch falls back to the concurrent, gzipped single uploads (429/5xx retried with backoff). The final line is still `{uploaded, skipped, failed}`; a failed map is logged with its reason. Re-posting the same bytes returns 200 and counts as `skipped`.

## 0.7.4

- Heap profiling (opt-in): `startProfiling({ types: ['cpu', 'heap'] })` or `WT_PROFILING_TYPES=cpu,heap` adds V8's sampling heap profiler. Each period posts a live-heap pprof with sample types `inuse_objects/count` and `inuse_space/bytes` to `/v1/profiles` (`heapIntervalBytes`, default 512 KiB). The default stays cpu only. New exports `parseProfilingTypes`, `foldHeap`.

## 0.7.3

- URL scrubbing is narrower: only secret-looking path segments are redacted (UUIDs, hex runs >= 16, JWTs, digit runs >= 16, random-looking tokens >= 16 chars mixing letters and digits). Hosts are never touched (also scheme-relative `//host`); readable words, kebab/snake slugs and short ids stay (`/atlas/.well-known/jwks.json`, `/gallery/legal-consultation-intake`, `/config/a1b2c3d4`). Behaviour change: 10 to 15 character ids that used to be redacted now show. Same rule as the browser SDK and the gateway. `looksSecret` is now `isSecretSegment`.
- `wt-next-sourcemaps --inject` / `uploadSourcemaps({ inject: true })`: writes a debug id into every `.next/static/**/*.js` chunk that has a map (`//# debugId=<uuid>` and a registration for the browser SDK) and into its map (`debugId`), then uploads with `debug_id`. Stable across rebuilds (hash of the chunk).
- README: custom-queue recipe names `job_queue_jobs` as the depth metric the Queues page and queue alerts read.

## 0.7.2

- `wt-next-sourcemaps` / `uploadSourcemaps()`: default API is `https://watchtowerops.net` (the old default did not resolve); one env name `WT_API_URL` (`WT_API` still works with a warning); a bad host fails fast naming it. Uploads run 8 at a time, retry 429/5xx honoring `Retry-After`, continue past failures, print `{uploaded, skipped, failed}` and exit 1 when any failed. Each map is sent with `for=<chunk path>`. Bodies are sent gzipped. `uploadSourcemaps()` now resolves `{uploaded, skipped, failed}` instead of throwing on a failed map.
- `init()` applies `nextInternals` itself when `NEXT_RUNTIME` is set (new `InitOptions.nextInternals` / `nextInternalsRate`), so the documented `init()` in `register()` filters Next's internal spans; never installed twice. Root `next.span_type` INTERNAL spans are sampled too (test with a parentless span).
- Next tunnel forwards `/v1/traces`.
- New export `@watchtowerobservability/node/messaging` (`produce`, `consume`) and a custom-queue recipe in the README.
- Start log line when datastore `requireParent` is on (`watchtower: requireParent on; queries outside a span are not recorded (WATCHTOWER_DB_REQUIRE_PARENT=0 to keep them)`); silenced by `instrumentLog: false` / `WT_INSTRUMENT_LOG=0`.

## 0.7.1

- Fix (bundlers): optional OpenTelemetry peers are no longer named by a literal `require` / `import()`; `load()` uses `createRequire` (from the SDK's location, then the app root), so webpack and Next no longer print "Module not found" for peers you did not install or a "Critical dependency" warning. Install the peers you use as direct dependencies of the app (for a Next standalone build add them to `outputFileTracingIncludes` if the tracer misses one).
- Fix (types): emitted `.d.ts` files mark every optional-peer import with `// @ts-ignore`, so `tsc` with `skipLibCheck: false` no longer fails with TS2307 when a peer is not installed (the type is `any` then, the real type when installed). `scripts/dts-peers.mjs` does it at build time; `test/dts-peers.test.ts` checks it.
- Fix: the `register` preload no longer prints Node 26's `DEP0205` (`module.register()`) deprecation warning.

## 0.7.0

- URL scrubbing on by default (`urlScrubbing: false` to opt out): a span processor drops the query string, removes `url.query` and replaces secret-looking path segments (>= 24 chars, or >= 10 chars with a letter and a digit; UUIDs too) with `:redacted` in `http.target`, `url.full`, `url.path`, `http.url` and URLs in span names, on every span including Next.js, http and fetch spans. `http.route` is kept. README no longer claims query strings are "never recorded" without saying how. Behaviour change: URLs that carried long ids now show `:redacted`.
- SQL summaries: `CREATE TABLE IF NOT EXISTS forms` is `CREATE TABLE forms`, `CREATE [UNIQUE] INDEX x ON forms` is `CREATE INDEX forms` (TEMP and VIRTUAL too); `DROP TABLE IF EXISTS` no longer reports `IF`. `db.operation.name` is `CREATE TABLE` / `CREATE INDEX` for these.
- `DbOptions.requireParent` (default true, `WATCHTOWER_DB_REQUIRE_PARENT=0` to turn off): datastore spans are recorded only under an active span, which keeps startup DDL, migrations and polling loops out. **Behaviour change** for every datastore integration and postgres.js: queries run outside any span used to become root traces and no longer do; pass `requireParent: false` to restore that.
- Resource attributes `telemetry.sdk.name/language/version` (from the OTel SDK) and `telemetry.distro.name=watchtower`, `telemetry.distro.version`. They were never set before (a bare resource was built; nothing stripped them), so the coverage report showed no SDK.
- `/next`: `nextInternals: 'drop' | 'sample' | 'keep'` (default `'sample'` at `nextInternalsRate` 0.1) for Next's internal spans (`next.span_type`); request, route-handler, render, server-action, fetch, SERVER/CLIENT and errored spans are kept. New `spanFilter` init option.
- `/next`: `withWatchtower(nextConfig, { sourcemaps })` (turns on `productionBrowserSourceMaps`), `uploadSourcemaps()` and the `wt-next-sourcemaps` bin (uploads `.next/static` maps with `WT_API_KEY` (scope `ci:write`), `WT_PROJECT`, `WT_RELEASE`, then deletes them), and `tunnelHandler({ endpoint })` for a first-party `app/api/wt/[...path]/route.ts` that forwards only the browser RUM paths.
- `instrument: 'auto'` (or `WT_INSTRUMENT=auto`): also patches postgres.js, better-sqlite3 and mysql2 (new optional peer `@opentelemetry/instrumentation-mysql2`) when installed and logs one line naming what was patched (`instrumentLog: false` / `WT_INSTRUMENT_LOG=0`).
- `wt.checkin(monitorSlug, fn)` cron helper over `POST /v1/checkins/{slug}` (key scope `ingest:checkins`).
- `init` now flushes on SIGTERM and SIGINT (2 s cap) and re-sends the signal when no other handler is registered. Not done before: a SIGTERM exited without flushing. Under `next start` Next's own handler still decides the exit.

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
