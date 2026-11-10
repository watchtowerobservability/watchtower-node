import { test, expect, vi } from 'vitest';

test('two copies of the module share one client (CJS + ESM copies of the package)', async () => {
  const a = await import('../src/index.js');
  vi.resetModules(); // a second, independent module instance, like the other module system's copy
  const b = await import('../src/index.js');
  expect(b).not.toBe(a);
  const c = a.init({ apiKey: 'k', captureProcessErrors: false, instrument: false });
  expect(() => b.log('info', 'from the other copy')).not.toThrow(); // would throw "init() has not been called"
  await expect(b.flush()).resolves.toBeDefined();
  expect((globalThis as Record<symbol, { current?: unknown }>)[Symbol.for('watchtower.node.state')]?.current).toBe(c);
  await b.shutdown();
});
