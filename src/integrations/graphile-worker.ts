import { trace } from '@opentelemetry/api';
import type { Attributes } from '@opentelemetry/api';
import { patch } from './db.js';
import { consume, injectData, produce, takeContext } from './messaging.js';

interface Helpers { job?: { id?: string | number; attempts?: number; queue_name?: string | null }; addJob?: unknown }
type Task = (payload: unknown, helpers: Helpers) => unknown;

const attrs = (task: string, type: 'send' | 'process', op: string): Attributes => ({
  'messaging.system': 'graphile-worker',
  'messaging.destination.name': task,
  'messaging.operation.type': type,
  'messaging.operation.name': op,
});

/**
 * `instrumentAddJob(utils)` (from `makeWorkerUtils`, or the runner from `run`): a PRODUCER span on
 * `addJob` with the trace context in the payload under `_wt` (object payloads only).
 * shortcut: the module-level `quickAddJob` cannot be patched under ESM; use `utils.addJob`.
 */
export function instrumentAddJob(utilsOrRunner: object): void {
  patch(utilsOrRunner, 'addJob', (orig) => function (this: unknown, identifier: string, payload?: unknown, ...rest: unknown[]) {
    return produce(`send ${identifier}`, attrs(identifier, 'send', 'addJob'), () => {
      const span = trace.getActiveSpan();
      return (orig.call(this, identifier, injectData(payload ?? {}), ...rest) as Promise<{ id?: unknown }>).then((job) => {
        if (job?.id !== undefined) span?.setAttribute('messaging.message.id', String(job.id));
        return job;
      });
    });
  });
}

/**
 * `run({ taskList: wrapTaskList({ send_email: async (payload, helpers) => ... }) })`: each task runs
 * in a CONSUMER span, child of and linked to the `addJob` that queued it; `_wt` is removed from the
 * payload first, and `helpers.addJob` is instrumented so follow-up jobs stay in the trace.
 */
export function wrapTaskList<T extends Record<string, Task>>(tasks: T): T {
  return Object.fromEntries(Object.entries(tasks).map(([name, fn]) => [name, (payload: unknown, helpers: Helpers) => {
    const carrier = takeContext(payload);
    const a: Attributes = attrs(name, 'process', 'task');
    if (helpers?.job?.id !== undefined) a['messaging.message.id'] = String(helpers.job.id);
    if (helpers?.job?.attempts !== undefined) a['messaging.graphile_worker.job.attempt'] = helpers.job.attempts;
    if (helpers?.job?.queue_name) a['messaging.consumer.group.name'] = helpers.job.queue_name;
    if (helpers) instrumentAddJob(helpers);
    return consume(`process ${name}`, a, [carrier], () => fn(payload, helpers));
  }])) as T;
}
