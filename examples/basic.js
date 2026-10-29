const wt = require('@watchtowerobservability/node');

const client = wt.init({ apiKey: process.env.WT_INGEST_KEY, serviceName: 'example-node' });
client.tracer.startActiveSpan('hello', (span) => span.end());
client.provider.shutdown(); // flush before exit
