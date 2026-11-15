import { test, expect } from 'vitest';
import type { ReadableSpan } from '@opentelemetry/sdk-trace';
import { isSecretSegment, scrubUrl, urlScrubber } from '../src/scrub.js';

test('query dropped and secret-looking segments redacted', () => {
  expect(scrubUrl('/api/feed/AbC123xyz987TokenTokenToken99/csv?since=x')).toBe('/api/feed/:redacted/csv');
  expect(scrubUrl('/api/status/ping/3f2b8c1e-9d4a-4e0b-8a7c-1b2c3d4e5f60/s3cr3tValue0123Xy')).toBe('/api/status/ping/:redacted/:redacted');
  expect(scrubUrl('https://user:pw@api.test/v1/x/abcdef0123456789abcdef0123?token=1#frag')).toBe('https://api.test/v1/x/:redacted');
});

test('plain words, numbers and short ids stay readable', () => {
  expect(scrubUrl('/gallery/contact/12345678901/v2/abc123?x=1')).toBe('/gallery/contact/12345678901/v2/abc123');
  expect(isSecretSegment('settings')).toBe(false);
  expect(isSecretSegment('forms2024xyz')).toBe(false);
  expect(isSecretSegment('a1b2c3d4Xk29dLq0')).toBe(true);
});

test('shared vectors (same list in the browser SDK and the gateway)', () => {
  const vectors: [string, string][] = [
    ["https://formize.net/atlas/.well-known/jwks.json", "https://formize.net/atlas/.well-known/jwks.json"],
    ["https://formize2.net/atlas/x", "https://formize2.net/atlas/x"],
    ["https://localhost:30000/atlas/x", "https://localhost:30000/atlas/x"],
    ["//cdn1234567.example.com/a", "//cdn1234567.example.com/a"],
    ["https://api.cookiemunch.net/config/default", "https://api.cookiemunch.net/config/default"],
    ["https://api.cookiemunch.net/config/a1b2c3d4", "https://api.cookiemunch.net/config/a1b2c3d4"],
    ["https://api.cookiemunch.net/config/Xk29dLq0aPz7Xk29", "https://api.cookiemunch.net/config/:redacted"],
    ["/gallery/legal-consultation-intake", "/gallery/legal-consultation-intake"],
    ["/reports/invoice-2024-q1-summary", "/reports/invoice-2024-q1-summary"],
    ["/api/feed/Xk29dLq0aPz7Xk29dLq0aPz7/csv?since=1", "/api/feed/:redacted/csv"],
    ["/invite/3b241101-e2bb-4255-8caf-4136c566a962/accept", "/invite/:redacted/accept"],
    ["/s/0123456789abcdef", "/s/:redacted"],
    ["/t/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln", "/t/:redacted"],
    ["/c/1234567890123456", "/c/:redacted"],
    ["/o/12345678901", "/o/12345678901"],
  ];
  for (const [i, o] of vectors) expect(scrubUrl(i)).toBe(o);
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
