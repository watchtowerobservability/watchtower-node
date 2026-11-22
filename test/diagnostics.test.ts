import { afterEach, expect, test, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { lateCheckApplies, lateModules, warnLate } from '../src/late.js';
import { StatusLine, failure, flushDrops, keyHint, noteDrop, watchMetrics, watchSpans } from '../src/diagnostics.js';

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); delete (globalThis as Record<symbol, unknown>)[Symbol.for('watchtower.node.late-warned')]; });

test('loaded too late: names http/https from the loaded-builtins list, once', () => {
  expect(lateModules(['NativeModule fs'])).toEqual([]);
  expect(lateModules(['NativeModule fs', 'NativeModule https', 'NativeModule http'])).toEqual(['http', 'https']);
  const out = vi.fn();
  warnLate(lateModules(['NativeModule http']), out);
  warnLate(lateModules(['NativeModule http']), out);
  expect(out).toHaveBeenCalledTimes(1);
  expect(out.mock.calls[0]![0]).toBe('[watchtower] loaded too late: http was already imported, so its requests are not traced. Start node with --import @watchtowerobservability/node/register');
  warnLate([], out); // nothing loaded: silent
});

test('a bare node process (what --import sees) has no http loaded, so there is no false positive', () => {
  const out = execFileSync(process.execPath, ['-e', `console.log(JSON.stringify(process.moduleLoadList.filter((m) => /^NativeModule https?$/.test(m))))`], { cwd: path.resolve(__dirname, '..') });
  expect(JSON.parse(out.toString())).toEqual([]);
});

test('status line: one line, pending until each signal has exported, off for disabled signals', () => {
  const out = vi.fn();
  const l = new StatusLine({ service: 'api', endpoint: 'https://ingest.example.com:4318', release: 'abc123', off: ['metrics'] }, out);
  l.record('traces', 3, { code: 0 });
  expect(out).not.toHaveBeenCalled();
  l.record('logs', 1, { code: 0 });
  expect(out).toHaveBeenCalledTimes(1);
  expect(out).toHaveBeenCalledWith('[watchtower] api → ingest.example.com:4318 traces:ok logs:ok metrics:off release=abc123');
  l.record('traces', 1, { code: 1, error: new Error('x') });
  expect(out).toHaveBeenCalledTimes(1);
});

test('status line: the first failure prints at once with the status', () => {
  const out = vi.fn();
  const l = new StatusLine({ service: 'api', endpoint: 'http://h' }, out);
  l.record('traces', 2, { code: 1, error: Object.assign(new Error('Export failed with retryable status 429'), { code: 429 }) });
  expect(out).toHaveBeenCalledWith('[watchtower] api → h traces:fail(429) logs:pending metrics:pending release=none');
  expect(failure(new Error('Bad Request: Export failed with status code 401'))).toBe('401');
  expect(failure(new Error('connect ECONNREFUSED'))).toBe('connect ECONNREFUSED');
});

test('exporter wrappers keep the inner exporter and report counts', () => {
  const out = vi.fn();
  const l = new StatusLine({ service: 's', endpoint: 'http://h', off: ['logs', 'metrics'] }, out);
  const inner = { export: vi.fn((_s: unknown[], d: (r: { code: number }) => void) => d({ code: 0 })), shutdown: async () => {}, extra: 7 };
  const w = watchSpans(inner as never, l) as unknown as typeof inner;
  const done = vi.fn();
  w.export([1, 2], done);
  expect(inner.export).toHaveBeenCalledTimes(1);
  expect(done).toHaveBeenCalledWith({ code: 0 });
  expect(w.extra).toBe(7);
  expect(out).toHaveBeenCalledTimes(1);
  const m = watchMetrics({ export: (_m: unknown, d: (r: { code: number }) => void) => d({ code: 0 }) } as never, l);
  m.export({ scopeMetrics: [{ metrics: [1, 2, 3] }] } as never, () => {});
});

test('WT_DEBUG logs results and drop summaries, and never the whole key', () => {
  vi.stubEnv('WT_DEBUG', '1');
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  new StatusLine({ service: 's', endpoint: 'http://h' }, () => {}).record('logs', 4, { code: 0 });
  noteDrop('Next.js internal spans'); noteDrop('Next.js internal spans');
  flushDrops();
  const lines = info.mock.calls.map((c) => String(c[0]));
  expect(lines).toContain('[watchtower:debug] export logs items=4 ok');
  expect(lines).toContain('[watchtower:debug] dropped in the last minute: 2 Next.js internal spans');
  expect(keyHint('wti_0123456789abcdef')).toBe('wti_0123…');
});

test('without WT_DEBUG nothing is logged by debug paths', () => {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  new StatusLine({ service: 's', endpoint: 'http://h' }, () => {}).record('logs', 4, { code: 0 });
  expect(info).not.toHaveBeenCalled();
});

test('loaded too late: silent under Next standalone, a Next entry point, and test runners', () => {
  expect(lateCheckApplies({})).toBe(true);
  expect(lateCheckApplies({ __NEXT_PRIVATE_STANDALONE_CONFIG: '{}' })).toBe(false);
  expect(lateCheckApplies({ NEXT_RUNTIME: 'nodejs' })).toBe(false);
  expect(lateCheckApplies({}, true)).toBe(false);
  expect(lateCheckApplies({ VITEST: 'true' })).toBe(false);
});

test('status line: after 90 s a signal that never exported reads none', () => {
  const out = vi.fn();
  const l = new StatusLine({ service: 's', endpoint: 'http://h' }, out);
  l.record('traces', 1, { code: 0 });
  l.expire();
  expect(out).toHaveBeenCalledWith('[watchtower] s → h traces:ok logs:none metrics:none release=none');
});
