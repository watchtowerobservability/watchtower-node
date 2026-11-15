import { test, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('load() falls back to the entry script directory (pnpm monorepo app)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-entry-'));
  fs.mkdirSync(path.join(dir, 'node_modules', 'wt-fake-peer'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'wt-fake-peer', 'index.js'), 'module.exports = { ok: 1 };');
  const argv1 = process.argv[1];
  try {
    const { load, searchPaths } = await import('../src/load.js');
    expect(() => load('wt-fake-peer')).toThrow();
    process.argv[1] = path.join(dir, 'main.js');
    expect(searchPaths().at(-1)).toBe(`${dir}/`);
    expect(load('wt-fake-peer')).toEqual({ ok: 1 });
  } finally {
    process.argv[1] = argv1!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('helpers are no-ops before init; observe and withMonitor still run the function', async () => {
  vi.resetModules();
  (globalThis as Record<symbol, unknown>)[Symbol.for('watchtower.node.state')] = { current: undefined };
  const w = await import('../src/index.js');
  expect(() => w.log('info', 'early')).not.toThrow();
  await expect(w.checkIn('j', 'ok')).resolves.toBeUndefined();
  await expect(w.checkin('j', () => 7)).resolves.toBe(7);
  await expect(w.withMonitor('j', async () => 8)).resolves.toBe(8);
  expect(w.observe('f', (a: number) => a + 1)(1)).toBe(2);
  await expect(w.score('t', 1)).resolves.toBeUndefined();
  await expect(w.evaluate([], () => 0, {})).resolves.toEqual([]);
});

test('tunnelHandler is exported from /tunnel and /next', async () => {
  const a = await import('../src/integrations/next-tunnel.js');
  const b = await import('../src/integrations/next.js');
  expect(b.tunnelHandler).toBe(a.tunnelHandler);
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  expect(pkg.exports['./tunnel'].import.default).toMatch(/next-tunnel\.js$/);
  expect(pkg.exports['./tunnel'].require.types).toMatch(/next-tunnel\.d\.ts$/);
});

test('the first helper call without init warns once that telemetry is off, with the reason', async () => {
  vi.resetModules();
  (globalThis as Record<symbol, unknown>)[Symbol.for('watchtower.node.state')] = { current: undefined };
  const w = await import('../src/index.js');
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const env = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    w.setOffReason('WT_INGEST_KEY is not set');
    w.log('info', 'a');
    w.log('info', 'b');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('telemetry is OFF: WT_INGEST_KEY is not set');
  } finally {
    process.env.NODE_ENV = env;
    warn.mockRestore();
  }
});

test('the ESM hook skips TypeScript sources (tsx), not JS', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'register.ts'), 'utf8');
  const re = new RegExp(src.match(/exclude: \[\/(.+?)\/\]/)![1]!);
  for (const f of ['file:///a/b.ts', 'file:///a/b.tsx', 'file:///a/b.mts?iitm=true', 'file:///a/b.cts#x']) expect(re.test(f)).toBe(true);
  for (const f of ['file:///a/b.js', 'file:///a/b.mjs', 'file:///a/node_modules/pg/lib/index.js', 'file:///a/b.tsconfig.json']) expect(re.test(f)).toBe(false);
});
