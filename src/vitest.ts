// Vitest reporter: `reporters: ['default', ['@watchtowerobservability/node/vitest', { /* apiKey, client, ... */ }]]`
// (or `new WatchtowerVitestReporter(opts)` in vitest.config). Reads the file/task tree handed to
// `onFinished`, which every Vitest version still calls. With the test-plan setup (test-plan.ts) it
// also reports quarantined failures and retries, and uploads JUnit when WT_CI_RUN_ID is set.
import { clientFor, reportTests, outcome } from './reporter-core.js';
import type { ReporterOptions, TestRecord } from './reporter-core.js';
import { suiteName, testId, uploadResults } from './test-plan.js';
import type { TestDecision } from './test-plan.js';
import type { Client } from './index.js';

/** The slice of Vitest's task tree this reporter reads. */
export interface VitestTask {
  type?: string;
  name: string;
  filepath?: string;
  mode?: string;
  meta?: { wt?: TestDecision; wtQuarantinedFailure?: string };
  result?: { state?: string; duration?: number; retryCount?: number; errors?: { message?: string }[] };
  tasks?: VitestTask[];
}

function collect(task: VitestTask, names: string[], file: string | undefined, out: TestRecord[], end: number): void {
  // a file task's name is its path; keep it out of test names
  const path = task.filepath ? [] : [...names, task.name];
  const f = task.filepath || file;
  if (task.type === 'test' || task.type === 'custom') {
    const r = task.result || {};
    const wt = task.meta?.wt;
    const qFail = task.meta?.wtQuarantinedFailure;
    const retried = r.retryCount || 0;
    out.push({
      name: path.join(' '),
      id: testId(suiteName('vitest'), f, path),
      outcome: qFail ? 'failed' : outcome(task.mode === 'skip' || task.mode === 'todo' ? 'skip' : r.state),
      durationMs: Math.round(r.duration || 0),
      message: qFail || (r.errors && r.errors[0] && r.errors[0].message),
      endMs: end,
      quarantined: qFail ? wt?.quarantined || 'no ticket' : undefined,
      isNew: wt?.isNew,
      // every retry before the final attempt was a failure
      attempts: r.state === 'fail' || r.state === 'pass' ? retried : 0,
    });
    return;
  }
  for (const t of task.tasks || []) collect(t, path, f, out, end);
}

export default class WatchtowerVitestReporter {
  private readonly client: Client | null;

  constructor(options?: ReporterOptions) {
    this.client = clientFor(options);
  }

  async onFinished(files?: VitestTask[]): Promise<void> {
    const tests: TestRecord[] = [];
    const end = Date.now();
    for (const f of files || []) collect(f, [], undefined, tests, end);
    await reportTests(this.client, tests, 'vitest');
    await uploadResults(this.client, suiteName('vitest'), tests);
    if (this.client) await this.client.shutdown().catch(() => {});
  }
}
