import { test, expect } from 'vitest';
import * as wt from '../src/index.js';
import { pinoStream } from '../src/integrations/logs.js';

type Rec = { attributes: Record<string, unknown> };
function client(redact?: wt.InitOptions['redact']) {
  const out: Rec[] = [];
  const c = new wt.Client({
    apiKey: 'k', redact, spanFilter: undefined,
    exporter: { export: (_s: unknown, d: (r: { code: number }) => void) => d({ code: 0 }), shutdown: async () => {}, forceFlush: async () => {} } as never,
    logExporter: { export: (l: Rec[], d: (r: { code: number }) => void) => { out.push(...l); d({ code: 0 }); }, shutdown: async () => {}, forceFlush: async () => {} } as never,
  });
  return { c, out };
}
const line = (o: object) => JSON.stringify({ level: 30, msg: 'req', ...o });

test('pino bridge: nested req is flattened and a user redact on the leaf key fires', async () => {
  const { c, out } = client((k, v) => (k === 'url' ? '' : v));
  pinoStream(c).write(line({ req: { method: 'GET', url: '/go/x/SECRET', remoteAddress: '1.2.3.4' }, tags: ['a', 'b'], deep: { a: { b: { c: { d: 1 } } } } }));
  await c.forceFlush();
  const a = out[0]!.attributes;
  expect(JSON.stringify(a)).not.toContain('SECRET');
  expect(a['req.method']).toBe('GET');
  expect(a['req.url']).toBe('');
  expect(a.tags).toEqual(['a', 'b']);
  expect(a['deep.a.b.c']).toBe('{"d":1}'); // depth 4 reached: JSON string
});

test('pii preset scrubs a flattened remoteAddress and URL scrubbing hits req.url', async () => {
  const { c, out } = client('pii');
  pinoStream(c).write(line({ req: { url: '/u/3f2b8c1e-4d5a-4b6c-9d7e-1a2b3c4d5e6f?x=1', remoteAddress: '10.1.2.3' } }));
  await c.forceFlush();
  const a = out[0]!.attributes;
  expect(a['req.remoteAddress']).toBe('[redacted:ipv4]');
  expect(a['req.url']).toBe('/u/:redacted');
});
