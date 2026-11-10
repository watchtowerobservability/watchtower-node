import { test, expect } from 'vitest';
import * as wt from '../src/index.js';
import { RemoteSampler, ratioFor, traceFraction } from '../src/sampling.js';
import { firstAppFrame } from '../src/origin.js';

test('ratioFor: probabilistic, first matching rule wins, status rules defer to the gateway', () => {
  expect(ratioFor({ strategyType: 'PROBABILISTIC', probabilisticSampling: { samplingRate: 0.25 } }, 's', '', 'x', {})).toBe(0.25);
  const cfg = {
    strategyType: 'RULES',
    rules: [
      { match: { status: 'error' }, action: { kind: 'drop' } },
      { match: { service: 'api', span_name_glob: 'GET /health*' }, action: { kind: 'drop' } },
      { match: { service: 'api' }, action: { kind: 'ratio', ratio: 0.1 } },
    ],
  };
  expect(ratioFor(cfg, 'api', '', 'GET /healthz', {})).toBe(0);
  expect(ratioFor(cfg, 'api', '', 'GET /x', {})).toBe(0.1);
  expect(ratioFor(cfg, 'web', '', 'GET /x', {})).toBe(1);
});

test('traceFraction is stable and spread over 0..1', () => {
  const f = traceFraction('0af7651916cd43dd8448eb211c80319c');
  expect(f).toBe(traceFraction('0af7651916cd43dd8448eb211c80319c'));
  let kept = 0;
  // trace ids are random in practice; a fixed LCG gives reproducible random-looking ids
  let x = 12345;
  const hex = () => Array.from({ length: 16 }, () => ((x = (x * 1103515245 + 12345) >>> 0) >>> 16 & 0xff).toString(16).padStart(2, '0')).join('');
  for (let i = 0; i < 2000; i++) if (traceFraction(hex()) < 0.25) kept++;
  expect(kept).toBeGreaterThan(350);
  expect(kept).toBeLessThan(650);
});

test('the sampler applies a polled config without restart and keeps the last one when polls fail', async () => {
  let rate = 1;
  let fail = false;
  const f = (async (url: string, init: { headers: Record<string, string> }) => {
    expect(url).toContain('/v1/sampling?service=svc');
    if (fail) throw new Error('down');
    return { ok: true, status: 200, headers: new Headers({ ETag: `"${rate}"` }), json: async () => ({ strategyType: 'PROBABILISTIC', probabilisticSampling: { samplingRate: rate } }) };
  }) as unknown as typeof fetch;
  const s = new RemoteSampler({ endpoint: 'http://x', headers: {}, service: 'svc', intervalMs: 3_600_000, fetch: f });
  const decide = () => { let n = 0; for (let i = 0; i < 400; i++) if (s.shouldSample(null as never, i.toString(16).padStart(32, '0'), 'op', 0, {}, []).decision === 2) n++; return n; };
  await s.poll();
  expect(decide()).toBe(400);
  rate = 0;
  await s.poll();
  expect(decide()).toBe(0);
  rate = 1;
  fail = true;
  await s.poll();
  expect(decide()).toBe(0); // fallback: last good config
  s.stop();
});

test('remoteSampling option wires a sampler into the client', async () => {
  const c = new wt.Client({ apiKey: 'k', endpoint: 'http://x:4318', exporter: { export: (_s: unknown, d: (r: { code: number }) => void) => d({ code: 0 }), shutdown: async () => {}, forceFlush: async () => {} } as never, remoteSampling: true, fetch: (async () => { throw new Error('down'); }) as never });
  expect(c.remoteSampler).toBeDefined();
  await c.shutdown();
});

test('firstAppFrame skips node_modules and internals', () => {
  const stack = [
    'Error', '    at codeOrigin (/app/node_modules/@watchtowerobservability/node/dist/origin.js:9:1)',
    '    at Module._compile (node:internal/modules/cjs/loader:1:1)',
    '    at handler (/srv/app/routes.ts:42:7)', '    at /srv/app/other.ts:9:3',
  ].join('\n');
  expect(firstAppFrame(stack)).toEqual({ file: '/srv/app/routes.ts', line: 42, fn: 'handler' });
  expect(firstAppFrame('Error\n    at /a.ts:1:1')).toEqual({ file: '/a.ts', line: 1, fn: undefined });
});
