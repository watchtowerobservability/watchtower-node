'use strict';
// Vitest reporter: `reporters: ['default', ['@watchtowerobservability/node/vitest', { /* apiKey, client, ... */ }]]`
// (or `new WatchtowerVitestReporter(opts)` in vitest.config). Reads the file/task tree handed to
// `onFinished`, which every Vitest version still calls.
const { clientFor, reportTests, outcome } = require('./reporter-core');

function collect(task, prefix, out, end) {
  // a file task's name is its path; keep it out of test names
  const name = task.filepath ? '' : prefix ? `${prefix} ${task.name}` : task.name;
  if (task.type === 'test' || task.type === 'custom') {
    const r = task.result || {};
    out.push({
      name,
      outcome: outcome(task.mode === 'skip' || task.mode === 'todo' ? 'skip' : r.state),
      durationMs: Math.round(r.duration || 0),
      message: r.errors && r.errors[0] && r.errors[0].message,
      endMs: end,
    });
    return;
  }
  for (const t of task.tasks || []) collect(t, name, out, end);
}

class WatchtowerVitestReporter {
  constructor(options) {
    this.client = clientFor(options);
  }

  async onFinished(files) {
    const tests = [];
    const end = Date.now();
    for (const f of files || []) collect(f, '', tests, end);
    await reportTests(this.client, tests);
    if (this.client) await this.client.shutdown().catch(() => {});
  }
}

module.exports = WatchtowerVitestReporter;
module.exports.default = WatchtowerVitestReporter;
