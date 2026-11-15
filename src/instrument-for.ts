// One call per framework: `instrument('nest')`. Applies the right instrumentation and returns what it enabled.
import { load } from './load.js';
import { instrumentOne } from './instrument.js';
import { setHttpServerActive } from './integrations/db.js';
import { instrumentPostgres } from './integrations/postgres.js';
import { instrumentBullMQ } from './integrations/bullmq.js';

export type Framework = 'nest' | 'express' | 'next' | 'bullmq' | 'pg' | 'postgres' | 'ioredis';
export interface InstrumentOptions {
  /** URLs never traced as outgoing calls (our own endpoint); `init` passes its own. */
  selfUrls?: string[];
}

const HTTP = '@opentelemetry/instrumentation-http';
const UNDICI = '@opentelemetry/instrumentation-undici';

/**
 * `instrument('nest' | 'express' | 'next' | 'bullmq' | 'pg' | 'postgres' | 'ioredis')`. Call it after `init()`.
 *
 * - `nest`, `express`: node:http server instrumentation; server spans are renamed `METHOD /route/:param` from the matched route (Nest on Express).
 * - `next`: http and undici (fetch); Next's own span filtering is `init`'s `nextInternals` (applied when `NEXT_RUNTIME` is set).
 * - `bullmq`: producer and worker spans with trace context in the job (`instrumentBullMQ`); order does not matter, it patches the classes.
 * - `postgres`: postgres.js through its diagnostics channel; order does not matter.
 * - `pg`, `ioredis`: the OTel instrumentation, which hooks `require`: call before the first `require('pg')` / `import 'pg'` (best: the `/register` preload).
 *
 * Returns the packages or integrations enabled by this call (empty when already on, or its peer is not installed).
 */
export function instrument(name: Framework, opts: InstrumentOptions = {}): string[] {
  const self = opts.selfUrls ?? [];
  const on = (pkgs: string[]): string[] => {
    const done = pkgs.filter((p) => instrumentOne(p, self));
    if (pkgs.includes(HTTP) && done.includes(HTTP)) setHttpServerActive(true);
    return done;
  };
  switch (name) {
    case 'nest': case 'express': return on([HTTP]);
    case 'next': return on([HTTP, UNDICI]);
    case 'pg': return on(['@opentelemetry/instrumentation-pg']);
    case 'ioredis': return on(['@opentelemetry/instrumentation-ioredis']);
    case 'postgres': load('postgres'); instrumentPostgres(); return ['postgres.js'];
    case 'bullmq': return instrumentBullMQ(load('bullmq') as Parameters<typeof instrumentBullMQ>[0]) ? ['bullmq'] : [];
    default: throw new Error(`watchtower: instrument(${JSON.stringify(name)}): expected nest, express, next, bullmq, pg, postgres or ioredis`);
  }
}
