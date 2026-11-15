import { afterEach, expect, test } from 'vitest';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { resolveRelease } from '../src/env.js';
import { dbRequireParent, setHttpServerActive } from '../src/integrations/db.js';
import { instrumentPostgres } from '../src/integrations/postgres.js';

test('resolveRelease: option > WT_RELEASE > otel > CI shas in order; empty/unknown skipped', () => {
  expect(resolveRelease('v1', { WT_RELEASE: 'v2', GITHUB_SHA: 'a' }, {})).toBe('v1');
  expect(resolveRelease(undefined, { WT_RELEASE: 'v2', GITHUB_SHA: 'a' }, {})).toBe('v2');
  expect(resolveRelease(undefined, { GITHUB_SHA: 'a' }, { 'service.version': '9' })).toBe('9');
  expect(resolveRelease(undefined, { GITHUB_SHA: ' ', CI_COMMIT_SHA: 'unknown', VERCEL_GIT_COMMIT_SHA: 'c', BUILD_SHA: 'd' }, {})).toBe('c');
  expect(resolveRelease(undefined, { HEROKU_SLUG_COMMIT: 'h' }, { 'service.version': 'unknown' })).toBe('h');
  expect(resolveRelease(undefined, {}, {})).toBeUndefined();
});

afterEach(() => { delete process.env.WATCHTOWER_DB_REQUIRE_PARENT; setHttpServerActive(false); });

test('requireParent default follows HTTP server instrumentation; option and env override', () => {
  expect(dbRequireParent(undefined)).toBe(false); // worker: root spans
  setHttpServerActive(true);
  expect(dbRequireParent(undefined)).toBe(true);
  expect(dbRequireParent(false)).toBe(false);
  process.env.WATCHTOWER_DB_REQUIRE_PARENT = '0';
  expect(dbRequireParent(undefined)).toBe(false);
  setHttpServerActive(false);
  process.env.WATCHTOWER_DB_REQUIRE_PARENT = '1';
  expect(dbRequireParent(undefined)).toBe(true);
});

test('instrumentPostgres without tracingChannel returns a no-op', () => {
  const cjs = createRequire(`${process.cwd()}/`)('node:diagnostics_channel');
  const orig = cjs.tracingChannel;
  cjs.tracingChannel = undefined;
  syncBuiltinESMExports();
  try { expect(typeof instrumentPostgres()).toBe('function'); } finally { cjs.tracingChannel = orig; syncBuiltinESMExports(); }
});

test('postgresMajor reads the installed version even when package.json is not exported', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { postgresMajor } = await import('../src/integrations/postgres.js');
  const root = mkdtempSync(join(tmpdir(), 'wt-pg-'));
  const pkg = join(root, 'node_modules', 'postgres');
  mkdirSync(join(pkg, 'cjs', 'src'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'postgres', version: '3.4.4', exports: { default: './cjs/src/index.js' } }));
  writeFileSync(join(pkg, 'cjs', 'src', 'index.js'), 'module.exports = {}');
  expect(postgresMajor(root)).toBe(3);
  expect(postgresMajor(tmpdir())).toBeUndefined();
});
