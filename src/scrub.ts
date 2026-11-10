// Default URL scrubbing: runs as a span processor so it covers spans the SDK did not create (Next.js, http, undici).
import type { SpanProcessor } from '@opentelemetry/sdk-trace';

const URL_KEYS = ['http.target', 'url.full', 'url.path', 'http.url', 'http.request.url'];
const QUERY_KEYS = ['url.query'];

/** A path segment that reads like a secret or an opaque id: >= 24 chars, or >= 10 chars mixing a letter and a digit (UUIDs included). */
export function looksSecret(seg: string): boolean {
  return seg.length >= 24 || (seg.length >= 10 && /[A-Za-z]/.test(seg) && /\d/.test(seg));
}

/** Drop the query string and fragment, strip `user:pass@`, and replace secret-looking path segments with `:redacted`. */
export function scrubUrl(value: string): string {
  const m = /^(?:([a-z][a-z0-9+.-]*:\/\/)([^/?#]*))?([^?#]*)/i.exec(value)!;
  const origin = m[1] ? m[1] + m[2]!.replace(/^[^@]*@/, '') : '';
  return origin + m[3]!.split('/').map((s) => (looksSecret(s) ? ':redacted' : s)).join('/');
}

function scrubName(name: string): string {
  return name.split(' ').map((t) => (/^(https?:\/\/|\/)/i.test(t) ? scrubUrl(t) : t)).join(' ');
}

/** Span processor: scrubs URL attributes (query dropped, `url.query` removed, secret path segments redacted) and URLs inside the span name. `http.route` is kept. */
export function urlScrubber(): SpanProcessor {
  return {
    onStart() {},
    onEnd(span) {
      const a = span.attributes as Record<string, unknown>;
      for (const k of URL_KEYS) if (typeof a[k] === 'string') a[k] = scrubUrl(a[k] as string);
      for (const k of QUERY_KEYS) delete a[k];
      const n = scrubName(span.name);
      if (n !== span.name) (span as unknown as { name: string }).name = n;
    },
    shutdown: () => Promise.resolve(),
    forceFlush: () => Promise.resolve(),
  };
}
