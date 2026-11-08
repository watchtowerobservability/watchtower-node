import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { isMainThread } from 'node:worker_threads';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import { capture, compile, createProbes, decorateExpr, paramNames, render, startProbes, tags } from '../src/probes.js';

const exporter = new InMemorySpanExporter();
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
trace.setGlobalTracerProvider(new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] }));

describe('probes', () => {
  it('condition subset refuses calls', () => {
    expect(() => compile('process.exit(1)')).toThrow();
    expect(compile("user.id == 7 && name in ['a', 'b']")({ user: { id: 7 }, name: 'a' })).toBe(true);
    expect(compile('total > 10')({ total: 3 })).toBe(false);
  });

  it('capture is bounded', () => {
    const out = capture({ a: { b: { c: { d: 1 } } }, big: 'x'.repeat(5000) }, 2, 2000);
    expect(out['a.b.c']).toBe('[depth limit]');
    expect(out.big).toHaveLength(1024);
  });

  it('hits are rate limited, conditional and expire', () => {
    const events: Record<string, string>[] = [];
    const bps: unknown[] = [];
    const p = createProbes({ emit: (_n, a) => events.push(a), now: () => 60_000, post: (d) => bps.push(d) });
    p.set([
      { id: 'p1', location: { file: 'src/app.js', line: 3 }, condition: 'total > 1', max_rate_per_min: 2 },
      { id: 'old', location: { file: 'src/app.js', line: 4 }, expires_at: 1 },
      { id: 'nofile', location: { function: 'f' } },
    ]);
    expect(bps[0]).toEqual([
      { id: 'p1', line: 3, urlRegex: '(^|/)src/app\\.js$' },
      { id: 'old', line: 4, urlRegex: '(^|/)src/app\\.js$' },
    ]);
    for (let i = 0; i < 3; i++) p.onHit({ ids: ['p1', 'old'], fn: 'f', url: 'file:///x/src/app.js', line: 3, vars: { total: 5 } });
    p.onHit({ ids: ['p1'], fn: 'f', url: 'u', line: 3, vars: { total: 0 } });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ 'probe.id': 'p1', 'code.lineno': '3', 'code.snapshot.total': '5' });
  });

  it.runIf(isMainThread)('a live probe snapshots locals of running code through the inspector', async () => {
    const events: Record<string, string>[] = [];
    const probes = [{ id: 'live', location: { file: 'fixtures/probe_target.cjs', line: 5 }, condition: 'total == 6' }];
    const fetchProbes = (async () => new Response(JSON.stringify({ probes }), { status: 200 })) as unknown as typeof fetch;
    const h = startProbes({ fetch: fetchProbes, emit: (_n, a) => events.push(a), key: 'k', service: 's' });
    const { checkout } = createRequire(__filename)('./fixtures/probe_target.cjs');
    try {
      for (let i = 0; i < 100 && events.length === 0; i++) {
        expect(checkout({ items: 3 })).toBe(6); // the getter never runs, so no throw
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(events[0]).toMatchObject({ 'probe.id': 'live', 'code.snapshot.total': '6', 'code.snapshot.order.items': '3' });
      expect(Object.keys(events[0]!).some((k) => k.includes('token'))).toBe(false);
    } finally {
      await h.stop();
    }
  });

  it('render, tags and the decoration expression stay data only', () => {
    expect(render('{user.id} paid {amount}{missing}', { user: { id: 'u1' }, amount: 3 })).toBe('u1 paid 3');
    const def = { id: 'd', location: {}, capture: { tags: [{ name: 'user.plan', value: '{plan}' }, { name: 'wt.project_id', value: 'x' }] } };
    expect(tags(def, { plan: 'pro' })).toEqual({ 'user.plan': 'pro' });
    expect(decorateExpr({ a: '"); process.exit(1); ("' })).toContain(JSON.stringify({ a: '"); process.exit(1); ("' }));
    expect(paramNames(function f(a: number, { b }: { b: number }, ...rest: unknown[]) { return [a, b, rest]; })).toEqual(['a', 'arg1', 'rest']);
  });

  it('span probes wrap a CommonJS export, end on throw and promise, and unwrap on removal', async () => {
    exporter.reset();
    const mod = createRequire(__filename)('./fixtures/probe_span_target.cjs');
    const orig = mod.charge;
    const p = createProbes({ now: () => 60_000, modules: () => ({ '/app/test/fixtures/probe_span_target.cjs': { exports: mod } }) });
    p.set([
      { id: 'sp', kind: 'span', location: { function: 'probe_span_target.cjs:charge' }, condition: 'amount != 1' },
      { id: 'sp2', kind: 'span', location: { function: 'later' } },
    ]);
    expect(mod.charge).not.toBe(orig);
    expect(mod.charge.name).toBe('charge');
    expect(mod.charge({ plan: 'pro' }, 5)).toBe(10);
    expect(mod.charge({ plan: 'pro' }, 1)).toBe(2); // condition false: no span
    expect(() => mod.charge({ plan: 'free' }, -5)).toThrow('negative');
    expect(await mod.later(1)).toBe(2);
    const spans = exporter.getFinishedSpans();
    expect(spans.map((x) => x.name)).toEqual(['probe charge', 'probe charge', 'probe later']);
    expect(spans[0]!.attributes['probe.id']).toBe('sp');
    expect(spans[1]!.status.code).toBe(2);
    p.set([]);
    expect(mod.charge).toBe(orig);
  });

  it.runIf(isMainThread)('a line span_decoration tags the active span through the inspector', async () => {
    exporter.reset();
    const probes = [{ id: 'tag', kind: 'span_decoration', location: { file: 'fixtures/probe_span_target.cjs', line: 6 },
      condition: "plan == 'pro'", capture: { tags: [{ name: 'user.plan', value: '{plan}' }] } }];
    const fetchProbes = (async () => new Response(JSON.stringify({ probes }), { status: 200 })) as unknown as typeof fetch;
    const h = startProbes({ fetch: fetchProbes, key: 'k', service: 's' });
    const { charge } = createRequire(__filename)('./fixtures/probe_span_target.cjs');
    const tracer = trace.getTracer('t');
    try {
      for (let i = 0; i < 100 && !exporter.getFinishedSpans().some((x) => x.attributes['user.plan']); i++) {
        tracer.startActiveSpan('outer', (span) => { charge({ plan: 'pro' }, 2); span.end(); });
        await new Promise((r) => setTimeout(r, 50));
      }
      const tagged = exporter.getFinishedSpans().find((x) => x.attributes['user.plan']);
      expect(tagged?.attributes['user.plan']).toBe('pro');
    } finally {
      await h.stop();
    }
  });
});
