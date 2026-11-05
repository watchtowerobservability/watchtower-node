import { afterEach, expect, test } from 'vitest';
import { checkSink, flushIast, guardSink, iastMiddleware, startIast, stopIast } from '../src/iast.js';

const calls: { url: string; body: any }[] = [];
const fakeFetch = (async (url: string, init: any) => {
  calls.push({ url, body: JSON.parse(init.body) });
  return { ok: true } as Response;
}) as unknown as typeof fetch;
const start = () => startIast({ apiUrl: 'http://api', apiKey: 'k', project: 'prj', service: 'web', fetch: fakeFetch, flushMs: 60000 });

afterEach(() => { stopIast(); calls.length = 0; });

const run = (req: object, fn: () => void) => iastMiddleware()(req, {}, fn);
const query = guardSink((_sql: string, _vals?: unknown[]) => 'rows', 'sql_injection');

test('request input concatenated into a query is reported once', async () => {
  start();
  const req = { query: { name: "bob' OR '1'='1" }, headers: {} };
  run(req, () => {
    query(`SELECT * FROM users WHERE name = '${req.query.name}'`);
    query(`SELECT * FROM users WHERE name = '${req.query.name}'`); // a second call site is a second finding
  });
  await flushIast();
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe('http://api/v1/projects/prj/code-security/runtime');
  expect(calls[0].body.service).toBe('web');
  expect(calls[0].body.findings).toHaveLength(2); // one per call site
  expect(calls[0].body.findings[0]).toMatchObject({ vuln_type: 'sql_injection' });
  expect(calls[0].body.findings[0].code_location).toMatch(/iast\.test\.ts:\d+/);
});

test('parameterised queries, constants and off-by-default report nothing', async () => {
  const req = { query: { name: 'alice' }, headers: {} };
  run(req, () => query('SELECT * FROM users WHERE name = alice')); // not started: no-op
  start();
  run(req, () => {
    query('SELECT * FROM users WHERE name = $1', [req.query.name]);
    query('SELECT 1');
  });
  expect(checkSink('sql_injection', 'alice outside a request')).toBe(false);
  await flushIast();
  expect(calls).toHaveLength(0);
});
