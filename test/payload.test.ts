import { test, expect } from 'vitest';
import type { Span } from '@opentelemetry/api';
import { capturePayload, graphqlOp, loadCaptureRules, redactText, setCaptureRules } from '../src/payload.js';

const fakeSpan = () => {
  const attrs: Record<string, unknown> = {};
  return { attrs, span: { setAttribute: (k: string, v: unknown) => { attrs[k] = v; } } as unknown as Span };
};

test('bodies are capped, redacted and only kept for matching routes', () => {
  setCaptureRules([{ route: '/api/*', body_bytes: 40, graphql_query: false }]);
  const { attrs, span } = fakeSpan();
  capturePayload(span, {
    route: '/api/login', reqType: 'application/json',
    reqBody: { user: 'a@b.io', password: 'hunter2', card: '4111 1111 1111 1111' },
    resType: 'image/png', resBody: 'binary',
  });
  const body = attrs['http.request.body'] as string;
  expect(Buffer.byteLength(body)).toBeLessThanOrEqual(40);
  expect(body).not.toContain('hunter2');
  expect(body).not.toContain('a@b.io');
  expect(attrs['http.response.body']).toBeUndefined();
  const other = fakeSpan();
  capturePayload(other.span, { route: '/health', reqBody: 'x' });
  expect(other.attrs).toEqual({});
  expect(redactText('4111 1111 1111 1112 ok')).toBe('4111 1111 1111 1112 ok');
});

test('graphql operation and document', () => {
  setCaptureRules([{ graphql_query: true }]);
  const { attrs, span } = fakeSpan();
  capturePayload(span, { route: '/graphql', reqType: 'application/json',
    reqBody: { query: '# c\nmutation AddUser($e: String) { add(email: "x@y.io") { id } }' } });
  expect(attrs['graphql.operation.type']).toBe('mutation');
  expect(attrs['graphql.operation.name']).toBe('AddUser');
  expect(attrs['graphql.document']).not.toContain('x@y.io');
  expect(attrs['http.request.body']).toBeUndefined();
  expect(graphqlOp('{ me { id } }')).toEqual({ type: 'query' });
  expect(graphqlOp('shoes')).toBeUndefined();
});

test('rules come from the edge with the ingest key; failures turn capture off', async () => {
  let seen = '';
  const f = (async (url: string, init?: RequestInit) => {
    seen = `${url} ${(init?.headers as Record<string, string>).Authorization}`;
    return new Response(JSON.stringify({ rules: [{ body_bytes: 10 }] }), { status: 200 });
  }) as unknown as typeof fetch;
  expect(await loadCaptureRules({ apiUrl: 'https://e', key: 'k', service: 'shop api', fetch: f })).toHaveLength(1);
  expect(seen).toBe('https://e/v1/capture-rules?service=shop%20api Bearer k');
  const bad = (async () => { throw new Error('down'); }) as unknown as typeof fetch;
  expect(await loadCaptureRules({ apiUrl: 'https://e', key: 'k', service: 's', fetch: bad })).toEqual([]);
});
