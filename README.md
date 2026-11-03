# @watchtowerobservability/node

[![CI](https://github.com/watchtowerobservability/watchtower-node/actions/workflows/ci.yml/badge.svg)](https://github.com/watchtowerobservability/watchtower-node/actions/workflows/ci.yml)

## Install

GitHub Packages needs a token with `read:packages` even for public packages:

```sh
npm install @watchtowerobservability/node
```

Or install the attested tarball from a release without a token:
`npm install https://github.com/watchtowerobservability/watchtower-node/releases/download/v0.2.0/watchtowerobservability-node-0.2.0.tgz`.

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
| AWS Lambda | `.../lambda` | `exports.handler = wrapHandler(async (event, ctx) => ...)` (async handlers; flushes before freeze) |
| Azure Functions | `.../azure-functions` | `app.http('fn', { handler: wrapFunction(async (req, ctx) => ...) })` (cold start, trigger, invocation id; flushes) |
| pino | `.../logs` | `pino(opts, pinoStream())` |
| winston | `.../logs` | `logger.add(watchtowerTransport())` |
| openai | `.../genai` | `instrumentOpenAI(new OpenAI())` |
| anthropic | `.../genai` | `instrumentAnthropic(new Anthropic())` |
| Mistral, Ollama | `.../genai` | `instrumentMistral(new Mistral())`, `instrumentOllama(ollama)` |
| LlamaIndex.TS | `.../genai` | `instrumentLlamaIndex(Settings)` |
| OpenAI Agents SDK | `.../genai` | `instrumentOpenAIAgents(addTraceProcessor)` |
| Vercel AI SDK | `.../genai` | `generateText({ experimental_telemetry: vercelAiTelemetry() })` |

GenAI spans follow the OTel GenAI semantic conventions (model, token usage, finish reasons); prompt and
completion text is not recorded. Streaming calls end their span at creation, without token usage.

## Profiling

```ts
import { startProfiling } from '@watchtowerobservability/node/profiling';
await startProfiling({ service: 'api' }); // key and endpoint from WT_INGEST_KEY / WT_OTLP_ENDPOINT
```

V8's own CPU sampler (`node:inspector`, 100 Hz, no native addon) is folded and posted to the
gateway's `/ingest` every 15 s as `<service>.cpu`. Idle time is left out. `withSpan(() => work())`
labels samples with the active OpenTelemetry span, so a trace links to its exact profile. By default
only its synchronous part counts. `startProfiling({ asyncSpans: true })` (or
`enableAsyncSpanLabels()`) also labels code after each `await`, through AsyncLocalStorage and V8
promise hooks. It is opt-in because its overhead has not been measured. Plain callbacks it starts
(timers, events) are labeled only from their own `await`s on. Past 100 000 labeled intervals in one
upload period, the rest of that period is unlabeled.

## Configuration

| Option | Env var | Default |
| --- | --- | --- |
| `apiKey` | `WT_INGEST_KEY` | required, sent as `Authorization: Bearer`, masked in output |
| `endpoint` | `WT_OTLP_ENDPOINT` | `http://localhost:4318` |
| `serviceName` | `WT_SERVICE` | `app` |
| `environment` | `WT_ENVIRONMENT` | unset |
| `release` | `WT_RELEASE` | unset |
| `bufferDir` | | no offline buffer (spans, logs and metrics spool to `traces/`, `logs/` and `metrics/`, 500 batches each) |
| `logs` | `WATCHTOWER_LOGS` (`OTEL_LOGS_EXPORTER=none` also turns it off) | `on`: OTLP logs (`log()`, pino, winston) |
| `metrics` | `WATCHTOWER_METRICS` (`OTEL_METRICS_EXPORTER=none` also turns it off) | `on`: OTLP metrics, see below |
| `redact` | | none; called for every span and log attribute |

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
