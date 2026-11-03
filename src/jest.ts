// Jest reporter: `reporters: ['default', ['@watchtowerobservability/node/jest', { /* apiKey, client, ... */ }]]`.
// With the test-plan environment (test-plan.ts) a quarantined failure arrives as a pending test that
// still carries its failure message; it is reported as a quarantined failure. Uploads JUnit when
// WT_CI_RUN_ID is set.
import { clientFor, reportTests, outcome } from './reporter-core.js';
import type { ReporterOptions, TestRecord } from './reporter-core.js';
import { decider, loadPlan, suiteName, testId, uploadResults } from './test-plan.js';
import type { Client } from './index.js';

/** The slice of Jest's `TestResult` this reporter reads. */
export interface JestTestResult {
  testFilePath?: string;
  testResults?: {
    fullName?: string;
    ancestorTitles?: string[];
    title: string;
    status?: string;
    duration?: number | null;
    failureMessages?: string[];
    invocations?: number;
  }[];
}

export default class WatchtowerJestReporter {
  private readonly client: Client | null;
  private readonly tests: TestRecord[] = [];

  constructor(_globalConfig?: unknown, options?: ReporterOptions) {
    this.client = clientFor(options);
  }

  onTestResult(_test: unknown, result: JestTestResult): void {
    const end = Date.now();
    const decide = decider(loadPlan());
    for (const t of result.testResults || []) {
      const names = (t.ancestorTitles || []).concat(t.title);
      const id = testId(suiteName('jest'), result.testFilePath, names);
      const d = decide(id);
      const failures = t.failureMessages || [];
      const qFail = d.quarantined !== undefined && t.status === 'pending' && failures.length > 0;
      this.tests.push({
        name: t.fullName || names.join(' '),
        id,
        outcome: qFail ? 'failed' : outcome(t.status),
        durationMs: t.duration || 0,
        message: failures[0],
        endMs: end,
        quarantined: qFail ? d.quarantined : undefined,
        isNew: d.isNew,
        attempts: Math.max(0, (t.invocations || 1) - 1),
      });
    }
  }

  async onRunComplete(): Promise<void> {
    await reportTests(this.client, this.tests, 'jest');
    await uploadResults(this.client, suiteName('jest'), this.tests);
    if (this.client) await this.client.shutdown().catch(() => {});
  }
}
