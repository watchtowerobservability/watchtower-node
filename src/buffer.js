'use strict';
// Offline buffer: failed OTLP batches are spooled to disk and replayed on the next export.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

class SpoolExporter {
  constructor(inner, dir, url, headers, fetchFn, opts) {
    this.inner = inner;
    this.dir = dir;
    this.url = url;
    this.headers = headers;
    this.fetch = fetchFn;
    this.maxFiles = (opts && opts.maxFiles) || 500;
    this.encode = (opts && opts.encode) || ((spans) => {
      const { JsonTraceSerializer } = require('@opentelemetry/otlp-transformer');
      return Buffer.from(JsonTraceSerializer.serializeRequest(spans));
    });
    fs.mkdirSync(dir, { recursive: true });
  }

  _files() {
    return fs.readdirSync(this.dir)
      .map((n) => ({ n, t: fs.statSync(path.join(this.dir, n)).mtimeMs }))
      .sort((a, b) => a.t - b.t || a.n.localeCompare(b.n))
      .map((f) => f.n);
  }

  async replay() {
    for (const n of this._files()) {
      const p = path.join(this.dir, n);
      try {
        const res = await this.fetch(this.url, {
          method: 'POST',
          headers: { ...this.headers, 'Content-Type': 'application/json' },
          body: fs.readFileSync(p),
        });
        if (!res.ok) return;
      } catch {
        return; // still offline; keep order
      }
      fs.unlinkSync(p);
    }
  }

  export(spans, done) {
    this.replay().then(() => this.inner.export(spans, (r) => {
      if (r.code !== 0) this._spool(this.encode(spans));
      done(r);
    }));
  }

  _spool(payload) {
    const files = this._files();
    for (const old of files.slice(0, Math.max(0, files.length - this.maxFiles + 1))) {
      fs.unlinkSync(path.join(this.dir, old)); // drop-oldest
    }
    fs.writeFileSync(path.join(this.dir, `${crypto.randomUUID()}.json`), payload);
  }

  shutdown() {
    return this.inner.shutdown();
  }

  forceFlush() {
    return this.inner.forceFlush ? this.inner.forceFlush() : Promise.resolve();
  }
}

module.exports = { SpoolExporter };
