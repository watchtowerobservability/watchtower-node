'use strict';
// Jest reporter: `reporters: ['default', ['@watchtowerobservability/node/jest', { /* apiKey, client, ... */ }]]`.
const { clientFor, reportTests, outcome } = require('./reporter-core');

class WatchtowerJestReporter {
  constructor(_globalConfig, options) {
    this.client = clientFor(options);
    this.tests = [];
  }

  onTestResult(_test, result) {
    const end = Date.now();
    for (const t of result.testResults || []) {
      this.tests.push({
        name: t.fullName || (t.ancestorTitles || []).concat(t.title).join(' '),
        outcome: outcome(t.status),
        durationMs: t.duration || 0,
        message: (t.failureMessages || [])[0],
        endMs: end,
      });
    }
  }

  async onRunComplete() {
    await reportTests(this.client, this.tests);
    if (this.client) await this.client.shutdown().catch(() => {});
  }
}

module.exports = WatchtowerJestReporter;
