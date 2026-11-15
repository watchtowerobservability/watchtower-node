// Default URL scrubbing: runs as a span processor so it covers spans the SDK did not create (Next.js, http, undici).
import type { SpanProcessor } from '@opentelemetry/sdk-trace';

const URL_KEYS = ['http.target', 'url.full', 'url.path', 'http.url', 'http.request.url'];
const QUERY_KEYS = ['url.query'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX = /^[0-9a-f]{16,}$/i;
const JWT = /^eyJ[\w-]*\.[\w-]+\.[\w-]*$/;
const DIGITS = /^\d{16,}$/;
const TOKEN = /^[A-Za-z0-9_+=-]{16,}$/;
// readable word-ish part of a kebab/snake slug: `legal`, `Intake`, `q1`, `2024`
const PART = /^([A-Za-z][a-z]*\d{0,2}|\d{1,4})$/;

/**
 * A path segment that looks like a secret: UUID, hex run >= 16, JWT, digit run >= 16, or an opaque token (>= 16 chars of
 * [A-Za-z0-9_+=-] with a letter and a digit that is not a readable kebab/snake slug). Words, slugs, short ids and file names stay.
 * Same rule in the browser SDK and the gateway (`redact.ScrubURL`).
 */
export function isSecretSegment(s: string): boolean {
  return UUID.test(s) || HEX.test(s) || JWT.test(s) || DIGITS.test(s) || (TOKEN.test(s) && /\d/.test(s) && /[a-z]/i.test(s) && !s.split(/[-_]/).every((p) => PART.test(p)));
}

/** Drop the query string and fragment, strip `user:pass@`, and replace secret-looking path segments with `:redacted`. The scheme and host are never touched. */
export function scrubUrl(value: string): string {
  const m = /^(?:([a-z][a-z0-9+.-]*:)?\/\/([^/?#]*))?([^?#]*)/i.exec(value)!;
  const origin = m[2] === undefined ? '' : `${m[1] ?? ''}//${m[2].replace(/^[^@]*@/, '')}`;
  return origin + m[3]!.split('/').map((s) => (isSecretSegment(s) ? ':redacted' : s)).join('/');
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
