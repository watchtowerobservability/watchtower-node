# @watchtowerobservability/node

[![CI](https://github.com/watchtowerobservability/watchtower-node/actions/workflows/ci.yml/badge.svg)](https://github.com/watchtowerobservability/watchtower-node/actions/workflows/ci.yml)

## Install

GitHub Packages needs a token with `read:packages` even for public packages:

```sh
echo '@watchtowerobservability:registry=https://npm.pkg.github.com' >> .npmrc
npm install @watchtowerobservability/node
```

Or install the attested tarball from a release without a token:
`npm install https://github.com/watchtowerobservability/watchtower-node/releases/download/v0.1.0/watchtowerobservability-node-0.1.0.tgz`.

Plain JavaScript (CommonJS) with hand-written `.d.ts` typings, a thin layer over the OpenTelemetry Node SDK
(ruling L1): `Authorization: Bearer` header, endpoint default (`WT_OTLP_ENDPOINT`), disk offline buffer,
`wt.*`-safe resource attributes, redaction hook, `getPrompt`, `score`, `evaluate`, `observe`.

```js
const wt = require('@watchtowerobservability/node');
wt.init({ apiKey: process.env.WT_INGEST_KEY, project: process.env.WT_PROJECT_ID, bufferDir: '.wt-buffer' });
```

## Quick start

```js
const wt = require('@watchtowerobservability/node');
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
| pino | `.../logs` | `pino(opts, pinoStream())` |
| winston | `.../logs` | `logger.add(watchtowerTransport())` |
| openai | `.../genai` | `instrumentOpenAI(new OpenAI())` |
| anthropic | `.../genai` | `instrumentAnthropic(new Anthropic())` |
| Vercel AI SDK | `.../genai` | `generateText({ experimental_telemetry: vercelAiTelemetry() })` |

GenAI spans follow the OTel GenAI semantic conventions (model, token usage, finish reasons); prompt and
completion text is not recorded. Streaming calls end their span at creation, without token usage.

## Configuration

| Option | Env var | Default |
| --- | --- | --- |
| `apiKey` | `WT_INGEST_KEY` | required, sent as `Authorization: Bearer`, masked in output |
| `endpoint` | `WT_OTLP_ENDPOINT` | `http://localhost:4318` |
| `serviceName` | `WT_SERVICE` | `app` |
| `environment` | `WT_ENVIRONMENT` | unset |
| `release` | `WT_RELEASE` | unset |
| `bufferDir` | | no offline buffer |
| `redact` | | none; called for every span and log attribute |

Examples: [`examples/express-app`](examples/express-app/server.js).

## Test reporters and resumable evals

Jest: `reporters: ['default', ['@watchtowerobservability/node/jest', {}]]`. Vitest: `reporters: ['default', ['@watchtowerobservability/node/vitest', {}]]`.
Each test becomes a span (`test.outcome`) and, with `WT_PROJECT_ID`, a `test_pass` score. Set `WT_INGEST_KEY`
(or pass `client`/`apiKey`); without a key the reporters do nothing.

`client.evaluateResume(dataset, task, scorers, previousRows)` re-runs only the cases that errored or are missing
(the Python SDK has `evaluate_resume`).

## Provenance

Every release artifact carries a GitHub build attestation. Verify one with
`gh attestation verify <file> --repo watchtowerobservability/watchtower-node`.

## License

Apache-2.0. Source of truth is the Watchtower monorepo; this repository is a published mirror.
