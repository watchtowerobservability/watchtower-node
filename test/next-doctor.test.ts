import { test, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { standaloneMissing, standaloneServer, standaloneUnloadable } from '../src/next-doctor.js';
import { SDK_PEERS, missingPeers } from '../src/load.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wt-doctor-'));

test('doctor: no standalone build is not an error; npm and pnpm layouts are read', () => {
  const d = tmp();
  expect(standaloneMissing(d)).toBeUndefined();
  const nm = path.join(d, '.next', 'standalone', 'node_modules');
  fs.mkdirSync(nm, { recursive: true });
  expect(standaloneMissing(d)).toHaveLength(SDK_PEERS.length + 1);
  fs.mkdirSync(path.join(nm, '@watchtowerobservability', 'node'), { recursive: true });
  for (const [i, p] of SDK_PEERS.entries()) {
    if (i % 2) fs.mkdirSync(path.join(nm, p), { recursive: true });
    else fs.mkdirSync(path.join(nm, '.pnpm', `${p.replace('/', '+')}@1.0.0`, 'node_modules'), { recursive: true });
  }
  expect(standaloneMissing(d)).toEqual([]);
  fs.rmSync(path.join(nm, SDK_PEERS[1]!), { recursive: true });
  expect(standaloneMissing(d)).toEqual([SDK_PEERS[1]]);
});

test('init warns once naming missing peers and the standalone fix', async () => {
  vi.resetModules();
  vi.doMock('../src/load.js', async (orig) => ({ ...(await orig<object>()), missingPeers: () => ['@opentelemetry/core'] }));
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const wt = await import('../src/index.js');
  try { wt.init({ apiKey: 'k', captureProcessErrors: false }); } catch { /* the real peers load; only the warning matters */ }
  const calls = warn.mock.calls.filter((c) => String(c[0]).includes('missing OpenTelemetry'));
  expect(calls).toHaveLength(1);
  expect(String(calls[0]![0])).toMatch(/@opentelemetry\/core.*withWatchtower/);
  expect(missingPeers).toBeTypeOf('function');
  vi.doUnmock('../src/load.js');
  warn.mockRestore();
});

test('doctor: finds a monorepo app server.js and reports a peer that does not load', () => {
  const d = tmp();
  const app = path.join(d, '.next', 'standalone', 'apps', 'web');
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, 'server.js'), '');
  const server = standaloneServer(d)!;
  expect(server).toBe(path.join(app, 'server.js'));
  const bad = standaloneUnloadable(server);
  expect(bad[0]).toMatch(/^@watchtowerobservability\/node: /);
  expect(bad.some((b) => b.startsWith('@opentelemetry/resources: '))).toBe(true);
});
