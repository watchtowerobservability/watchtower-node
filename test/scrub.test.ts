import { test, expect } from 'vitest';
import type { ReadableSpan } from '@opentelemetry/sdk-trace';
import { looksSecret, scrubUrl, urlScrubber } from '../src/scrub.js';

test('query dropped and secret-looking segments redacted', () => {
  expect(scrubUrl('/api/feed/AbC123xyz987TokenTokenToken99/csv?since=x')).toBe('/api/feed/:redacted/csv');
  expect(scrubUrl('/api/status/ping/3f2b8c1e-9d4a-4e0b-8a7c-1b2c3d4e5f60/s3cr3tValue0123')).toBe('/api/status/ping/:redacted/:redacted');
  expect(scrubUrl('https://user:pw@api.test/v1/x/abcdef0123456789abcdef0123?token=1#frag')).toBe('https://api.test/v1/x/:redacted');
});

test('plain words, numbers and short ids stay readable', () => {
  expect(scrubUrl('/gallery/contact/12345678901/v2/abc123?x=1')).toBe('/gallery/contact/12345678901/v2/abc123');
  expect(looksSecret('settings')).toBe(false);
  expect(looksSecret('forms2024xyz')).toBe(true);
  expect(looksSecret('a'.repeat(24))).toBe(true);
});

test('processor scrubs url attributes and span names, keeps http.route, removes url.query', () => {
  const span = {
    name: 'GET /api/feed/AbC123xyz987TokenTokenToken99',
    attributes: {
      'http.target': '/api/feed/AbC123xyz987TokenTokenToken99/csv?since=x', 'url.full': 'https://a.test/p?q=1', 'url.query': 'since=x',
      'http.route': '/api/feed/[token]/csv', 'http.url': 'https://a.test/a/0123456789abcdef', 'url.path': '/ok',
    } as Record<string, unknown>,
  };
  urlScrubber().onEnd(span as unknown as ReadableSpan);
  expect(span.name).toBe('GET /api/feed/:redacted');
  expect(span.attributes).toEqual({
    'http.target': '/api/feed/:redacted/csv', 'url.full': 'https://a.test/p', 'http.route': '/api/feed/[token]/csv',
    'http.url': 'https://a.test/a/:redacted', 'url.path': '/ok',
  });
});
