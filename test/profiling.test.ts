import { describe, expect, it } from 'vitest';
import { inspect } from 'node:util';
import { Session } from 'node:inspector';
import { Profiler, enableAsyncSpanLabels, foldProfile, foldedBody, ingestUrl, takeIntervals, withSpan } from '../src/profiling.js';

const f = (functionName: string, url = '', lineNumber = 0) => ({ functionName, url, lineNumber });

describe('profiling', () => {
  it('folds V8 samples root first and drops idle', () => {
    const counts = foldProfile({
      nodes: [
        { id: 1, callFrame: f('(root)'), children: [2, 4] },
        { id: 2, callFrame: f('main', 'file:///app/a.js', 9), children: [3] },
        { id: 3, callFrame: f('work', 'file:///app/a.js', 19) },
        { id: 4, callFrame: f('(idle)') },
      ],
      samples: [3, 3, 2, 4],
    });
    expect([...counts]).toEqual([['main (a.js:10);work (a.js:20)', 2], ['main (a.js:10)', 1]]);
    expect(foldedBody(new Map([['a;b', 2]]))).toBe('a;b 2\n');
  });

  it('labels samples inside a span interval, by timestamp', () => {
    const prefix = 'span_id=ab,trace_id=cd\t';
    const counts = foldProfile({
      nodes: [{ id: 1, callFrame: f('(root)'), children: [2] }, { id: 2, callFrame: f('work') }],
      samples: [2, 2, 2],
      startTime: 100,
      timeDeltas: [10, 10, 10], // 110, 120, 130
    }, [{ start: 115, end: 125, prefix }]);
    expect(counts.get('work')).toBe(2);
    expect(counts.get(`${prefix}work`)).toBe(1);
  });

  it('withSpan intervals share the clock of a real V8 profile', async () => {
    const s = new Session();
    s.connect();
    const post = (m: string) => new Promise<any>((res, rej) => s.post(m, (e: Error | null, r?: object) => (e ? rej(e) : res(r))));
    await post('Profiler.enable');
    await post('Profiler.start');
    const prefix = `span_id=${'ab'.repeat(8)},trace_id=${'cd'.repeat(16)}\t`;
    const start = Number(process.hrtime.bigint() / 1000n);
    withSpan(() => { const end = Date.now() + 200; while (Date.now() < end) Math.sqrt(Math.random()); }, { spanId: 'ab'.repeat(8), traceId: 'cd'.repeat(16) });
    const end = Number(process.hrtime.bigint() / 1000n);
    const { profile } = await post('Profiler.stop');
    s.disconnect();
    const labeled = [...foldProfile(profile, [{ start, end, prefix }]).keys()].filter((k) => k.startsWith(prefix));
    expect(labeled.length).toBeGreaterThan(0);
  });

  it('withSpan labels code after await once async labels are on', async () => {
    const ids = { spanId: 'ef'.repeat(8), traceId: '01'.repeat(16) };
    const prefix = `span_id=${ids.spanId},trace_id=${ids.traceId}\t`;
    const now = () => Number(process.hrtime.bigint() / 1000n);
    const run = () => {
      const t = { afterAwait: 0, afterSecond: 0 };
      return withSpan(async () => {
        await new Promise((r) => setTimeout(r, 5));
        t.afterAwait = now();
        await new Promise((r) => setTimeout(r, 5));
        t.afterSecond = now();
        return t;
      }, ids);
    };
    const mine = () => takeIntervals(now()).filter((iv) => iv.prefix === prefix);
    const covers = (ivs: { start: number; end: number }[], at: number) => ivs.some((iv) => iv.start <= at && iv.end >= at);
    const off = await run(); // off by default: the synchronous part only
    expect(covers(mine(), off.afterAwait)).toBe(false);
    enableAsyncSpanLabels();
    const on = await run();
    const outside = now();
    const ivs = mine();
    expect(covers(ivs, on.afterAwait) && covers(ivs, on.afterSecond)).toBe(true);
    expect(covers(ivs, outside)).toBe(false);
  });

  it('names service, type and labels in the ingest URL', () => {
    const u = new URL(ingestUrl('http://gw:4318/', 'api', { env: 'prod', version: undefined }, 10.5, 25, 100));
    expect(u.pathname).toBe('/ingest');
    expect(u.searchParams.get('name')).toBe('api.cpu{env=prod}');
    expect([u.searchParams.get('from'), u.searchParams.get('format')]).toEqual(['10', 'folded']);
  });

  it('needs a key, hides it and samples this process', async () => {
    expect(() => new Profiler({ apiKey: '' })).toThrow();
    const p = new Profiler({ apiKey: 'wtk_fake', endpoint: 'http://127.0.0.1:9', periodMs: 60_000 });
    expect(inspect(p)).not.toContain('wtk_fake');
    await p.start();
    const end = Date.now() + 50;
    while (Date.now() < end) Math.sqrt(Math.random());
    await p.stop();
    expect(p.dropped + p.uploaded).toBeLessThanOrEqual(1);
  });
});
