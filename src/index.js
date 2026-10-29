'use strict';
// Thin Watchtower layer over the OpenTelemetry Node SDK: key header, endpoint default,
// offline buffer, wt.*-safe resource attributes, redaction hook, getPrompt/score/evaluate/observe.
const { trace } = require('@opentelemetry/api');
const { Resource } = require('@opentelemetry/resources');
const { BatchSpanProcessor } = require('@opentelemetry/sdk-trace-base');
const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node');
const { SpoolExporter } = require('./buffer');

const DEFAULT_ENDPOINT = 'http://localhost:4318';

/** Drop caller-supplied wt.* keys: tenant identity comes only from the key. */
function safeResource(attrs) {
  return Object.fromEntries(Object.entries(attrs || {}).filter(([k]) => !k.startsWith('wt.')));
}

class Client {
  constructor(opts) {
    const o = opts || {};
    if (!o.apiKey) throw new Error('apiKey is required');
    const env = process.env;
    this.endpoint = (o.endpoint || env.WT_OTLP_ENDPOINT || DEFAULT_ENDPOINT).replace(/\/+$/, '');
    this.apiUrl = (o.apiUrl || env.WT_API_URL || this.endpoint).replace(/\/+$/, '');
    this.project = o.project || env.WT_PROJECT_ID;
    this.headers = { Authorization: `Bearer ${o.apiKey}` };
    this.fetch = o.fetch || globalThis.fetch;
    const resource = new Resource({ 'service.name': o.serviceName || 'app', ...safeResource(o.resource) });
    this.provider = new NodeTracerProvider({ resource });
    if (o.redact) this.provider.addSpanProcessor(redactor(o.redact));
    let exporter = o.exporter;
    if (!exporter) {
      const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
      const url = `${this.endpoint}/v1/traces`;
      exporter = new OTLPTraceExporter({ url, headers: this.headers });
      if (o.bufferDir) exporter = new SpoolExporter(exporter, o.bufferDir, url, this.headers, this.fetch);
    }
    this.provider.addSpanProcessor(new BatchSpanProcessor(exporter));
    this.tracer = this.provider.getTracer('watchtower');
  }

  async _call(method, path, body) {
    const url = `${this.apiUrl}/v1/projects/${this.project}/llm/${path}`;
    const res = await this.fetch(url, {
      method,
      headers: { ...this.headers, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`watchtower ${method} ${path}: HTTP ${res.status}`);
    return res.json();
  }

  getPrompt(promptId) {
    return this._call('GET', `prompts/${promptId}`);
  }

  score(traceId, value, o) {
    const x = o || {};
    const body = { trace_id: traceId, value, name: x.name || 'user_feedback', source: 'sdk' };
    if (x.spanId) body.span_id = x.spanId;
    if (x.comment) body.comment = x.comment;
    return this._call('POST', 'scores', body);
  }

  /** Run task per case under a span; record each scorer result as a score when a project is set. */
  async evaluate(dataset, task, scorers, o) {
    const x = { name: 'evaluate', errorTolerance: true, ...o };
    const rows = [];
    // resume: rows of an earlier run; cases that finished without errors are kept, not re-run
    const done = new Map((x.resume || []).filter((r) => !Object.keys(r.errors || {}).length).map((r) => [r.case, r]));
    for (const [i, c] of dataset.entries()) {
      if (done.has(i)) { rows.push(done.get(i)); continue; }
      await this.tracer.startActiveSpan(`${x.name}.case`, async (span) => {
        const traceId = span.spanContext().traceId;
        const row = { case: i, traceId, scores: {}, errors: {} };
        rows.push(row);
        try {
          const out = await task(c && c.input !== undefined ? c.input : c);
          for (const [name, fn] of Object.entries(scorers)) {
            try {
              row.scores[name] = await fn(c, out);
              if (this.project) await this.score(traceId, row.scores[name], { name });
            } catch (e) {
              if (!x.errorTolerance) throw e;
              row.errors[name] = String(e.message || e);
            }
          }
        } catch (e) {
          if (!x.errorTolerance) throw e;
          row.errors.task = String(e.message || e);
        } finally {
          span.end();
        }
      });
    }
    return rows;
  }

  /** Re-run only the cases that errored or are missing in `previous`. */
  evaluateResume(dataset, task, scorers, previous, o) {
    return this.evaluate(dataset, task, scorers, { ...o, resume: previous });
  }

  /** Wrap fn in a span. */
  observe(name, fn) {
    return (...args) => this.tracer.startActiveSpan(name, (span) => {
      const end = () => span.end();
      try {
        const r = fn(...args);
        if (r && typeof r.then === 'function') return r.finally(end);
        end();
        return r;
      } catch (e) {
        end();
        throw e;
      }
    });
  }

  shutdown() {
    return this.provider.shutdown();
  }
}

function redactor(hook) {
  return {
    onStart() {},
    onEnd(span) {
      for (const k of Object.keys(span.attributes)) span.attributes[k] = hook(k, span.attributes[k]);
    },
    shutdown: () => Promise.resolve(),
    forceFlush: () => Promise.resolve(),
  };
}

let current;
function init(opts) {
  current = new Client(opts);
  current.provider.register(); // global tracer + async context so trace.getActiveSpan() works
  return current;
}
function need() {
  if (!current) throw new Error('watchtower.init() has not been called');
  return current;
}

module.exports = {
  Client,
  init,
  safeResource,
  DEFAULT_ENDPOINT,
  getPrompt: (id) => need().getPrompt(id),
  score: (t, v, o) => need().score(t, v, o),
  evaluate: (d, t, s, o) => need().evaluate(d, t, s, o),
  evaluateResume: (d, t, s, prev, o) => need().evaluateResume(d, t, s, prev, o),
  observe: (n, f) => need().observe(n, f),
  shutdown: () => (current ? current.shutdown() : Promise.resolve()),
  trace,
};
