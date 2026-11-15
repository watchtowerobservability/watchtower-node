import { afterEach, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { context } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace';
import * as wt from '../src/index.js';
import { gitHeadSha, resolveRelease } from '../src/env.js';
import { isSecretKey, luhn, presetHook, resolveRedact, scrubPii } from '../src/redact-presets.js';
import { droppedDbSpans, setHttpServerActive, startDbSpan } from '../src/integrations/db.js';
import { expressRoute, routeNamer } from '../src/integrations/util.js';

type Done = (r: { code: number }) => void;
const spans: ReadableSpan[] = [];
const client = wt.init({
  apiKey: 'test-key-not-real', captureProcessErrors: false, logs: false, metrics: false, instrument: false, redact: 'pii',
  exporter: { export: (s: ReadableSpan[], done: Done) => { spans.push(...s); done({ code: 0 }); }, shutdown: async () => {}, forceFlush: async () => {} },
});

afterEach(() => { delete process.env.WATCHTOWER_DB_REQUIRE_PARENT; setHttpServerActive(false); });

test('init status: traces ok, switched-off signals disabled, nothing blocked', () => {
  expect(client).toMatchObject({ traces: 'ok', metrics: 'disabled', logs: 'disabled', blocked: [], attached: false });
  expect(client.warnings).toEqual([]);
});

test('secret-shaped keys are redacted, counters and gen_ai token fields are not', () => {
  for (const k of ['authorization', 'http.request.header.cookie', 'http.response.header.set-cookie', 'db.password', 'x-api-key', 'api_key', 'session.id', 'client_secret', 'access_token']) expect(isSecretKey(k), k).toBe(true);
  for (const k of ['http.route', 'gen_ai.token.type', 'gen_ai.usage.input_tokens', 'user.id', 'service.name']) expect(isSecretKey(k), k).toBe(false);
  const h = presetHook('strict')!;
  expect(h('authorization', 'Bearer abc')).toBe('[redacted]');
  expect(h('token', 5)).toBe(5);
  expect(h('http.request.header.cookie', ['a=1', 'b=2'])).toEqual(['[redacted]', '[redacted]']);
  expect(h('user.email', 'a@b.co')).toBe('a@b.co'); // strict leaves PII text alone
  expect(presetHook('off')).toBeUndefined();
});

test('pii preset masks emails, phones, Luhn-valid cards and IPs', () => {
  expect(luhn('4111 1111 1111 1111')).toBe(true);
  expect(luhn('4111 1111 1111 1112')).toBe(false);
  expect(scrubPii('mail ann@example.com now')).toBe('mail [redacted:email] now');
  expect(scrubPii('card 4111 1111 1111 1111 ok')).toBe('card [redacted:card] ok');
  expect(scrubPii('order 4111 1111 1111 1112')).toBe('order 4111 1111 1111 1112');
  expect(scrubPii('call +1 415 555 0132')).toBe('call [redacted:phone]');
  expect(scrubPii('from 10.1.2.3 and 999.1.1.1')).toBe('from [redacted:ipv4] and 999.1.1.1');
  expect(scrubPii('v6 2001:db8:0:0:0:0:0:1')).toBe('v6 [redacted:ipv6]');
});

test('resolveRedact: default strict, a function runs after the preset', () => {
  expect(resolveRedact(undefined).preset).toBe('strict');
  expect(resolveRedact('off').hook).toBeUndefined();
  const { hook } = resolveRedact((k, v) => (k === 'x' ? 'user' : v));
  expect(hook!('password', 'p')).toBe('[redacted]');
  expect(hook!('x', 'p')).toBe('user');
});

test('redact preset applies to span attributes and names end to end', async () => {
  client.observe('op for ann@example.com', () => {
    const s = wt.trace.getActiveSpan()!;
    s.setAttribute('http.request.header.authorization', 'Bearer abc');
    s.setAttribute('note', 'ip 10.0.0.1');
    s.setAttribute('http.target', '/a/b?token=1');
  })();
  await wt.flush();
  const s = spans.find((x) => x.name.startsWith('op for'))!;
  expect(s.name).toBe('op for [redacted:email]');
  expect(s.attributes['http.request.header.authorization']).toBe('[redacted]');
  expect(s.attributes.note).toBe('ip [redacted:ipv4]');
  expect(s.attributes['http.target']).toBe('/a/b');
});

test('release: build stamp after CI vars; git HEAD last and only when asked', () => {
  expect(resolveRelease(undefined, { BUILD_STAMP: 'b1' }, {})).toBe('b1');
  expect(resolveRelease(undefined, { WT_BUILD_STAMP: 'w1', BUILD_STAMP: 'b1' }, {})).toBe('w1');
  expect(resolveRelease(undefined, { WT_BUILD_STAMP: 'w1', GITHUB_SHA: 'g' }, {})).toBe('g');
  expect(resolveRelease(undefined, {}, {})).toBeUndefined();
});

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wt-git-'));

test('gitHeadSha: loose ref, packed-refs, detached, found from a subdirectory, none', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, '.git/refs/heads'), { recursive: true });
  fs.mkdirSync(path.join(root, 'a/b'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git/HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(root, '.git/refs/heads/main'), `${A}\n`);
  expect(gitHeadSha(path.join(root, 'a/b'))).toBe(A);
  fs.rmSync(path.join(root, '.git/refs/heads/main'));
  fs.writeFileSync(path.join(root, '.git/packed-refs'), `# pack-refs\n${B} refs/heads/main\n${A} refs/heads/other\n`);
  expect(gitHeadSha(root)).toBe(B);
  fs.writeFileSync(path.join(root, '.git/HEAD'), `${A}\n`);
  expect(gitHeadSha(root)).toBe(A);
  expect(resolveRelease(undefined, {}, {}, root)).toBe(A);
  fs.rmSync(path.join(root, '.git'), { recursive: true });
  expect(gitHeadSha(root)).toBeUndefined();
});

test('gitHeadSha follows a worktree .git file and its commondir', () => {
  const root = tmp();
  const main = path.join(root, 'main.git');
  const wtGit = path.join(main, 'worktrees/w');
  fs.mkdirSync(path.join(main, 'refs/heads'), { recursive: true });
  fs.mkdirSync(wtGit, { recursive: true });
  fs.writeFileSync(path.join(main, 'refs/heads/feat'), `${B}\n`);
  fs.writeFileSync(path.join(wtGit, 'HEAD'), 'ref: refs/heads/feat\n');
  fs.writeFileSync(path.join(wtGit, 'commondir'), '../..\n');
  const work = path.join(root, 'work');
  fs.mkdirSync(work);
  fs.writeFileSync(path.join(work, '.git'), `gitdir: ${wtGit}\n`);
  expect(gitHeadSha(work)).toBe(B);
});

test('requireParent drops are counted', () => {
  process.env.WATCHTOWER_DB_REQUIRE_PARENT = '1';
  const before = droppedDbSpans();
  expect(startDbSpan({ system: 'sqlite', sql: 'SELECT 1' }, undefined, context.active()).isRecording()).toBe(false);
  expect(droppedDbSpans()).toBe(before + 1);
});

test('route naming: Express route path with base url; skipped without a string route', () => {
  expect(expressRoute({ baseUrl: '/api', route: { path: '/users/:id' } })).toBe('/api/users/:id');
  expect(expressRoute({ route: { path: /x/ } })).toBeUndefined();
  const calls: unknown[][] = [];
  const span = { updateName: (n: string) => calls.push(['name', n]), setAttribute: (k: string, v: string) => calls.push([k, v]) };
  routeNamer(span as never, { method: 'GET', baseUrl: '/api', route: { path: '/users/:id' } });
  expect(calls).toEqual([['name', 'GET /api/users/:id'], ['http.route', '/api/users/:id']]);
  calls.length = 0;
  routeNamer(span as never, { method: 'GET' });
  expect(calls).toEqual([]);
});

test('instrument() rejects an unknown framework', () => {
  expect(() => wt.instrument('flask' as never)).toThrow(/expected nest/);
});
