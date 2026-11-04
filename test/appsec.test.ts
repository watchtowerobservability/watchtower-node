import { afterEach, expect, test } from 'vitest';
import { appsecMiddleware, fromNode, inspect, isUserBlocked, setRuleset, startAppsec } from '../src/appsec.js';
import type { Ruleset } from '../src/appsec.js';

const RULES: Ruleset = {
  mode: 'monitor',
  rules: [
    { id: 'sqli-union', category: 'sqli', fields: ['query', 'body', 'path'], pattern: '\\bunion\\b(?:\\s+all)?\\s+(?:distinct\\s+)?select\\b' },
    { id: 'scanner-ua', category: 'scanner', fields: ['user_agent'], pattern: 'sqlmap|nikto' },
    { id: 'broken', category: 'custom', fields: ['path'], pattern: '(' },
  ],
  denylist: { ip: [{ value: '203.0.113.9', expires_at: null }], user: [{ value: 'mallory', expires_at: 1 }] },
};

afterEach(() => setRuleset(null));

const res = () => {
  const out = { statusCode: 200, headers: {} as Record<string, string>, body: '' };
  return Object.assign(out, {
    setHeader: (k: string, v: string) => { out.headers[k] = v; },
    end: (b?: string) => { out.body = b || ''; },
  });
};

test('requests are decoded once and matched case-insensitively', () => {
  setRuleset(RULES);
  const r = fromNode({ url: '/search?q=1%20UNION+SELECT%20pw', headers: { 'user-agent': 'curl/8', 'x-forwarded-for': '198.51.100.1, 10.0.0.1' } });
  expect(r.query).toBe('q=1 UNION SELECT pw');
  expect(r.ip).toBe('198.51.100.1');
  expect(inspect(r)).toMatchObject({ action: 'monitor', rule_id: 'sqli-union', category: 'sqli' });
  expect(inspect({ path: '/', user_agent: 'sqlmap/1.7' }).rule_id).toBe('scanner-ua');
  expect(inspect({ path: '/books', query: 'q=union station' }).action).toBe('allow');
});

test('block mode answers 403 and denylisted callers are always blocked', () => {
  setRuleset({ ...RULES, mode: 'block' });
  const out = res();
  let called = false;
  appsecMiddleware()({ url: '/?q=1 union select 2', headers: {} }, out, () => { called = true; });
  expect(called).toBe(false);
  expect(out.statusCode).toBe(403);
  expect(out.headers['content-type']).toBe('application/problem+json');

  setRuleset(RULES);
  const deny = res();
  appsecMiddleware()({ url: '/', headers: { 'x-real-ip': '203.0.113.9' } }, deny, () => { called = true; });
  expect(deny.statusCode).toBe(403);
  expect(called).toBe(false);
  expect(isUserBlocked('mallory'), 'expired entry').toBe(false);

  const ok = res();
  appsecMiddleware()({ url: '/?q=1 union select 2', headers: {} }, ok, () => { called = true; });
  expect(called, 'monitor mode lets the request through').toBe(true);
});

test('the poller sends the key and the ETag', async () => {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const fake = (async (url: string, init: { headers: Record<string, string> }) => {
    seen.push({ url, headers: init.headers });
    return new Response(JSON.stringify(RULES), { status: 200, headers: { etag: '"abc"' } });
  }) as unknown as typeof fetch;
  const p = startAppsec({ apiUrl: 'https://edge.test/', key: 'wti_x', service: 'api', fetch: fake });
  await p.ready;
  p.stop();
  expect(seen[0]!.url).toBe('https://edge.test/v1/appsec/ruleset?service=api');
  expect(seen[0]!.headers.Authorization).toBe('Bearer wti_x');
  expect(inspect({ path: '/', ip: '203.0.113.9' }).action).toBe('block');
});
