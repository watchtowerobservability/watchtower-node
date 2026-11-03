// Payload and GraphQL capture (APM-016), driven by the capture rules set in Watchtower per service
// and route (`GET /v1/capture-rules?service=`, an ingestion key with scope `probes:read`).
// Opt-in: nothing is fetched or recorded unless `init({ captureRules: true })` or
// `WT_CAPTURE_RULES=1`, and a rule matches the route. Only text-like bodies are kept, at most the
// rule's `body_bytes` (hard cap 8 KiB), after the default secret and PII detectors (a port of the
// pipeline's redact stage; ingest applies the project's detectors again).
// shortcut: rules are fetched once at init; poll with the ETag (`poll_s`) when long-lived processes need live edits.
import type { Span } from '@opentelemetry/api';

export interface CaptureRule {
  route?: string | null;
  request_headers?: string[];
  response_headers?: string[];
  body_bytes?: number;
  graphql_query?: boolean;
}

export const HARD_MAX = 8192;
const R = '[REDACTED]';
let rules: CaptureRule[] = [];

export const setCaptureRules = (r: CaptureRule[]): void => { rules = Array.isArray(r) ? r : []; };
export const captureActive = (): boolean => rules.length > 0;

/** Fetch the service's rules; any failure leaves capture off. */
export async function loadCaptureRules(o: { apiUrl: string; key: string; service: string; fetch?: typeof fetch }): Promise<CaptureRule[]> {
  try {
    const f = o.fetch || globalThis.fetch;
    const res = await f(`${o.apiUrl}/v1/capture-rules?service=${encodeURIComponent(o.service)}`, {
      headers: { Authorization: `Bearer ${o.key}` },
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { rules?: CaptureRule[] };
    setCaptureRules(body.rules || []);
  } catch {
    setCaptureRules([]);
  }
  return rules;
}

/** `*` matches any run of characters (the edge's glob). */
export function glob(pat: string, s: string): boolean {
  const body = pat.split('*').map((p) => p.replace(/[.+?^$()|{}[\]\\]/g, '\\$&')).join('.*');
  return new RegExp('^' + body + '$', 's').test(s);
}

export const ruleFor = (route: string): CaptureRule | undefined =>
  rules.find((r) => !r.route || glob(r.route, route));

const luhn = (s: string): boolean => {
  const d = s.replace(/\D/g, '');
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let x = Number(d[d.length - 1 - i]);
    if (i % 2) x = x * 2 > 9 ? x * 2 - 9 : x * 2;
    sum += x;
  }
  return d.length >= 13 && sum % 10 === 0;
};

const SECRET_KEYS = 'password|passwd|secret|token|access_token|refresh_token|client_secret|api_?key|authorization';
const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  /bearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /wt[ik]_[a-z0-9]{8}_[A-Za-z0-9_-]{43}/g,
  /(?:AKIA|ASIA)[0-9A-Z]{16}/g,
  /gh[pousr]_[A-Za-z0-9]{36,}/g,
  /[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
  /\b\d{3}-\d{2}-\d{4}\b/g,
];

/** Default secret and PII detectors: secret-named JSON and form fields, keys, tokens, emails, SSNs, Luhn-valid cards. */
export function redactText(s: string): string {
  let out = s
    .replace(new RegExp(`("(?:${SECRET_KEYS})"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`, 'gi'), `$1"${R}"`)
    .replace(new RegExp(`\\b((?:${SECRET_KEYS})=)[^&\\s]*`, 'gi'), `$1${R}`);
  for (const re of PATTERNS) out = out.replace(re, R);
  return out.replace(/\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{1,7}\b/g, (m) => (luhn(m) ? R : m));
}

export const textLike = (type?: string): boolean =>
  !type || /json|^text\/|xml|x-www-form-urlencoded|graphql/i.test(type);

/** First `n` UTF-8 bytes without splitting a character. */
export function capBytes(s: string, n: number): string {
  const b = Buffer.from(s, 'utf8');
  if (b.length <= n) return s;
  return b.subarray(0, n).toString('utf8').replace(/�$/, '');
}

/** Redact a wider window than kept so a secret cut at the edge is still masked, then cap. */
export const excerpt = (s: string, n: number): string => capBytes(redactText(capBytes(s, n * 2)), n);

/** Operation type and name of a GraphQL document (`{ ... }` is an anonymous query). */
export function graphqlOp(doc: string): { type: string; name?: string } | undefined {
  const d = doc.replace(/#[^\n]*/g, '');
  const m = /(?:^|\})\s*(query|mutation|subscription)\b\s*([_A-Za-z][_0-9A-Za-z]*)?/.exec(d);
  if (m) return { type: m[1]!, ...(m[2] ? { name: m[2] } : {}) };
  return /^\s*\{/.test(d) ? { type: 'query' } : undefined;
}

export interface Payload {
  route: string;
  reqType?: string;
  reqBody?: unknown;
  resType?: string;
  resBody?: unknown;
}

const asText = (b: unknown): string | undefined => {
  if (b === undefined || b === null) return undefined;
  if (typeof b === 'string') return b;
  if (Buffer.isBuffer(b)) return b.toString('utf8');
  if (typeof (b as { pipe?: unknown }).pipe === 'function') return undefined; // a stream: never buffered
  try { return JSON.stringify(b); } catch { return undefined; }
};

/** Record the bodies and GraphQL operation on `span` per the rule matching the route; no rule, nothing recorded. */
export function capturePayload(span: Span, p: Payload): void {
  const rule = ruleFor(p.route);
  if (!rule) return;
  const n = Math.min(rule.body_bytes || 0, HARD_MAX);
  const req = textLike(p.reqType) ? asText(p.reqBody) : undefined;
  const res = textLike(p.resType) ? asText(p.resBody) : undefined;
  if (n > 0 && req) span.setAttribute('http.request.body', excerpt(req, n));
  if (n > 0 && res) span.setAttribute('http.response.body', excerpt(res, n));
  let doc: string | undefined;
  let opName: string | undefined;
  if (req && /graphql/i.test(p.reqType || '')) doc = req;
  else if (req) {
    try {
      const j = (typeof p.reqBody === 'object' ? p.reqBody : JSON.parse(req)) as { query?: unknown; operationName?: unknown };
      if (j && typeof j.query === 'string') { doc = j.query; if (typeof j.operationName === 'string') opName = j.operationName; }
    } catch { /* not JSON */ }
  }
  const op = doc ? graphqlOp(doc) : undefined;
  if (!op || !doc) return;
  span.setAttribute('graphql.operation.type', op.type);
  const name = opName || op.name;
  if (name) span.setAttribute('graphql.operation.name', name);
  if (rule.graphql_query) span.setAttribute('graphql.document', excerpt(doc, HARD_MAX));
}
