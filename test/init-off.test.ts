import { expect, test, vi } from 'vitest';

vi.mock('node:module', async (orig) => {
  const m = await orig<typeof import('node:module')>();
  const fail = (id: string) => /sdk-trace|sdk-logs/.test(id);
  return { ...m, createRequire: (f: string) => Object.assign((id: string) => { if (fail(id)) throw Object.assign(new Error(`Cannot find module '${id}'`), { code: 'MODULE_NOT_FOUND' }); return m.createRequire(f)(id); }, m.createRequire(f)) };
});

test('init() with missing peers never throws, warns once listing every missing package, and returns a no-op client', async () => {
  const wt = await import('../src/index.js');
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const c = wt.init({ apiKey: 'k' });
  expect(warn).toHaveBeenCalledTimes(1);
  expect(String(warn.mock.calls[0][0])).toMatch(/sdk-trace.*sdk-logs|sdk-logs.*sdk-trace/);
  expect(await c.checkin('s', () => 7)).toBe(7);
  expect(c.observe('n', () => 3)()).toBe(3);
  expect(() => c.log('info', 'x')).not.toThrow();
  await expect(c.forceFlush()).resolves.toBeUndefined();
  expect(wt.observe('x', () => 5)()).toBe(5); // helpers stay no-ops
});
