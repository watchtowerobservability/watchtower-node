import { context, propagation, trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { Attributes, Span } from '@opentelemetry/api';
import { CONTEXT_KEY, injectData as inject, isPlainObject } from './messaging.js';
import { captureException } from '../errors.js';
import { monitorJob, slugify } from '../cron/monitor.js';

export { CONTEXT_KEY };

interface JobLike {
  id?: string;
  name: string;
  data: unknown;
  attemptsMade?: number;
  opts?: { delay?: number; attempts?: number; repeat?: { pattern?: string; cron?: string; tz?: string } };
}
type Fn = (this: { name: string }, ...a: any[]) => Promise<any>;
interface BullMQLike {
  Queue: { prototype: Record<string | symbol, unknown> };
  Worker: { prototype: Record<string | symbol, unknown> };
}

const PATCHED = Symbol.for('watchtower.bullmq');
const tracer = () => trace.getTracer('watchtower');
const base = (queue: string, op: 'send' | 'process', name: string): Attributes => ({
  'messaging.system': 'bullmq',
  'messaging.destination.name': queue,
  'messaging.operation.type': op,
  'messaging.operation.name': name,
});

async function run<T>(span: Span, fn: () => Promise<T>, recorded?: () => boolean): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!recorded?.()) span.recordException(e as Error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: (e as Error)?.message });
    throw e;
  } finally {
    span.end();
  }
}

export interface BullMQOptions {
  /** Report a job's failure as an error when it is the last attempt (no retry left): queue, job name and id, attempt, attemptsMade and attempts as attributes. */
  captureFailures?: boolean;
  /** Run repeatable jobs (`repeat.pattern`/`cron`) as cron monitors named `<queue>-<job name>`; needs the `ingest:checkins` key scope. */
  cronMonitors?: boolean;
}

/**
 * `import * as bullmq from 'bullmq'; instrumentBullMQ(bullmq)` (ESM or CJS): PRODUCER spans on
 * `Queue.add`/`addBulk`, CONSUMER spans around each job a `Worker` processes, parented by the
 * producer's context carried in job data under `_wt` (stripped before your processor runs; object
 * data only). Call it once, before creating queues and workers. Returns false when this bullmq
 * has no `Worker.callProcessJob` (consumer spans off; producer spans still on). Options: see `BullMQOptions`.
 * shortcut: sandboxed (file path) processors run in a child process and get no consumer span.
 */
export function instrumentBullMQ(bullmq: BullMQLike, options: BullMQOptions = {}): boolean {
  const q = bullmq.Queue.prototype;
  const w = bullmq.Worker.prototype;
  if (q[PATCHED]) return typeof w.callProcessJob === 'function';
  q[PATCHED] = true;

  const add = q.add as Fn;
  q.add = function (this: { name: string }, name: string, data: unknown, opts?: { delay?: number }) {
    const attrs: Attributes = { ...base(this.name, 'send', 'add'), 'messaging.bullmq.job.name': name };
    if (opts?.delay) attrs['messaging.bullmq.job.delay_ms'] = opts.delay;
    return tracer().startActiveSpan(`send ${this.name}`, { kind: SpanKind.PRODUCER, attributes: attrs }, (span) =>
      run(span, async () => {
        const job = (await add.call(this, name, inject(data), opts)) as JobLike | undefined;
        if (job?.id) span.setAttribute('messaging.message.id', job.id);
        return job;
      }));
  };

  const addBulk = q.addBulk as Fn | undefined;
  if (addBulk) {
    q.addBulk = function (this: { name: string }, jobs: Array<{ data?: unknown }>) {
      const attrs = { ...base(this.name, 'send', 'addBulk'), 'messaging.batch.message_count': jobs.length };
      return tracer().startActiveSpan(`send ${this.name}`, { kind: SpanKind.PRODUCER, attributes: attrs }, (span) =>
        run(span, () => addBulk.call(this, jobs.map((j) => ({ ...j, data: inject(j.data) })))));
    };
  }

  const call = w.callProcessJob as Fn | undefined;
  if (typeof call !== 'function') return false;
  w.callProcessJob = function (this: { name: string }, job: JobLike, ...rest: unknown[]) {
    let parent = context.active();
    if (isPlainObject(job.data) && isPlainObject(job.data[CONTEXT_KEY])) {
      parent = propagation.extract(parent, job.data[CONTEXT_KEY]);
      delete job.data[CONTEXT_KEY];
    }
    const attrs: Attributes = {
      ...base(this.name, 'process', 'process'),
      'messaging.bullmq.job.name': job.name,
      'messaging.bullmq.job.attempt': (job.attemptsMade ?? 0) + 1,
    };
    if (job.id) attrs['messaging.message.id'] = job.id;
    if (job.opts?.delay) attrs['messaging.bullmq.job.delay_ms'] = job.opts.delay;
    const queue = this.name;
    const rep = job.opts?.repeat;
    const cron = options.cronMonitors ? rep?.pattern ?? rep?.cron : undefined;
    return tracer().startActiveSpan(`process ${queue}`, { kind: SpanKind.CONSUMER, attributes: attrs }, parent, (span) => {
      let recorded = false;
      const exec = async () => {
        try {
          return await call.call(this, job, ...rest);
        } catch (e) {
          const attempts = job.opts?.attempts ?? 1;
          const made = (job.attemptsMade ?? 0) + 1;
          if (options.captureFailures && (made >= attempts || (e as Error)?.name === 'UnrecoverableError')) {
            captureException(e, { attributes: {
              'bullmq.queue': queue, 'bullmq.job.name': job.name, 'bullmq.job.id': job.id, 'bullmq.job.attempt': made,
              'bullmq.job.attempts_made': made, 'bullmq.job.attempts': attempts,
            } });
            recorded = true;
          }
          throw e;
        }
      };
      const slug = cron ? slugify(`${queue}-${job.name}`) : '';
      return run(span, () => (slug ? monitorJob(slug, exec, { schedule: cron, timezone: rep?.tz }) : exec()), () => recorded);
    });
  };
  return true;
}
