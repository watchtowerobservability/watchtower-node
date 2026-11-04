import { trace } from '@opentelemetry/api';
import type { Attributes } from '@opentelemetry/api';
import { patch } from './db.js';
import { consume, injectData, produce, takeContext } from './messaging.js';

interface Job { id?: string; name?: string; data?: unknown; retryCount?: number }
interface SendRequest { name: string; data?: unknown; options?: unknown }

const attrs = (queue: string, type: 'send' | 'process', op: string): Attributes => ({
  'messaging.system': 'pg-boss',
  'messaging.destination.name': queue,
  'messaging.operation.type': type,
  'messaging.operation.name': op,
});

/** Run `call` and set the returned job id on the active (producer) span. */
function withId<T>(call: () => Promise<T>): Promise<T> {
  const span = trace.getActiveSpan();
  return call().then((id) => {
    if (typeof id === 'string') span?.setAttribute('messaging.message.id', id);
    return id;
  });
}

/**
 * `instrumentPgBoss(boss)`: PRODUCER spans on `send` and `insert` (context in job data under `_wt`,
 * object data only), and a CONSUMER span around each `work` handler call, child of the producer for
 * a single job and linked to every job's producer for a batch. `_wt` is removed before the handler
 * sees `job.data`. `messaging.system` is `pg-boss` (OTel has no value for it).
 * shortcut: sendAfter/sendThrottled/sendDebounced/sendSingleton bypass `send`; their jobs carry no context.
 */
export function instrumentPgBoss(boss: object): void {
  patch(boss, 'send', (orig) => function (this: unknown, nameOrReq: string | SendRequest, data?: unknown, ...rest: unknown[]) {
    if (typeof nameOrReq === 'object' && nameOrReq) {
      const req = nameOrReq;
      return produce(`send ${req.name}`, attrs(req.name, 'send', 'send'),
        () => withId(() => orig.call(this, { ...req, data: injectData(req.data) }, data, ...rest)));
    }
    return produce(`send ${nameOrReq}`, attrs(nameOrReq, 'send', 'send'),
      () => withId(() => orig.call(this, nameOrReq, injectData(data), ...rest)));
  });
  // v9: insert(jobs[]); v10: insert(name, jobs[])
  patch(boss, 'insert', (orig) => function (this: unknown, a: string | Job[], b?: unknown, ...rest: unknown[]) {
    const jobs = (Array.isArray(a) ? a : b) as Job[] | undefined;
    const queue = typeof a === 'string' ? a : jobs?.[0]?.name ?? '';
    const at = { ...attrs(queue, 'send', 'insert'), 'messaging.batch.message_count': jobs?.length ?? 0 };
    return produce(`send ${queue}`, at, () => {
      const out = jobs?.map((j) => ({ ...j, data: injectData(j.data) }));
      return Array.isArray(a) ? orig.call(this, out, b, ...rest) : orig.call(this, a, out, ...rest);
    });
  });
  patch(boss, 'work', (orig) => function (this: unknown, name: string, ...rest: unknown[]) {
    const i = rest.length - 1;
    const handler = rest[i];
    if (typeof handler !== 'function') return orig.call(this, name, ...rest);
    rest[i] = function (this: unknown, arg: Job | Job[]) {
      const jobs = Array.isArray(arg) ? arg : [arg];
      const a: Attributes = attrs(name, 'process', 'work');
      if (jobs.length === 1 && jobs[0]?.id) a['messaging.message.id'] = jobs[0].id;
      if (Array.isArray(arg)) a['messaging.batch.message_count'] = arg.length;
      return consume(`process ${name}`, a, jobs.map((j) => takeContext(j?.data)), () => handler.call(this, arg));
    };
    return orig.call(this, name, ...rest);
  });
}
