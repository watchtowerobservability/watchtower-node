# @watchtowerobservability/node

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
