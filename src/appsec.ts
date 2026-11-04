// App and API Protection in-app WAF (W52). `startAppsec()` polls the project's ruleset from the
// edge (`GET /v1/appsec/ruleset`, an ingestion key with scope `probes:read`, ETag, every `poll_s`):
// mode, enabled pattern rules and the denylist. `appsecMiddleware()` (Express, Connect, any
// `(req, res, next)` stack) or `handleRequest(req, res)` (plain `http`, Fastify `onRequest`, Koa)
// inspects each request before the handler: path, query, User-Agent, other header values and an
// already parsed body, percent-decoded once, against the same rules the worker runs over stored
// spans. A match is recorded on the active server span (`appsec.event`, `appsec.rule_id`,
// `appsec.category`, `appsec.blocked`); in `block` mode, and for denylisted IPs or users in any
// mode, the request is answered with 403 problem+json and the handler never runs.
// Nothing is fetched or inspected until `startAppsec` is called; with no ruleset yet every
// request passes. Rules are matched case-insensitively; a rule that does not compile is skipped.
import { trace } from '@opentelemetry/api';

export type Field = 'path' | 'query' | 'user_agent' | 'body' | 'headers';
export interface AppsecRule {
  id: string;
  name?: string;
  category: string;
  severity?: string;
  fields: Field[];
  pattern: string;
}
export interface DenyEntry {
  value: string;
  /** Unix seconds; null: no expiry. */
  expires_at?: number | null;
}
export interface Ruleset {
  mode: 'monitor' | 'block';
  rules: AppsecRule[];
  denylist?: { ip?: DenyEntry[]; user?: DenyEntry[] };
  poll_s?: number;
}
/** One request as the inspector sees it (decoded). */
export interface Inspected {
  path: string;
  query?: string;
  user_agent?: string;
  body?: string;
  headers?: string;
  ip?: string;
  user?: string;
}
export interface Decision {
  /** `allow`: nothing matched; `monitor`: matched, let through; `block`: answer 403. */
  action: 'allow' | 'monitor' | 'block';
  rule_id?: string;
  category?: string;
  match?: string;
}

/** Rule id recorded for denylist blocks (the worker reports them as their own signal). */
export const DENYLIST = 'denylist';
const BODY_MAX = 64 * 1024;

let mode: Ruleset['mode'] = 'monitor';
let compiled: { rule: AppsecRule; re: RegExp }[] = [];
let denyIp = new Map<string, number>();
let denyUser = new Map<string, number>();

const expiryMap = (list: DenyEntry[] | undefined): Map<string, number> =>
  new Map((list || []).map((e) => [e.value, e.expires_at ? e.expires_at * 1000 : Infinity]));

/** Replace the active ruleset (what the poller calls; tests may call it directly). */
export function setRuleset(r: Ruleset | null): void {
  mode = r?.mode === 'block' ? 'block' : 'monitor';
  compiled = [];
  for (const rule of r?.rules || []) {
    try {
      compiled.push({ rule, re: new RegExp(rule.pattern, 'i') });
    } catch {
      // not portable to JavaScript: skipped here, the worker still evaluates it
    }
  }
  denyIp = expiryMap(r?.denylist?.ip);
  denyUser = expiryMap(r?.denylist?.user);
}

const listed = (m: Map<string, number>, v: string | undefined, now: number): boolean =>
  !!v && (m.get(v) ?? 0) > now;

/** Whether `id` is on the user denylist (call after authentication to refuse a listed user). */
export const isUserBlocked = (id: string, now = Date.now()): boolean => listed(denyUser, id, now);

/** Judge one request. Denylisted callers are blocked in either mode. */
export function inspect(req: Inspected, now = Date.now()): Decision {
  if (listed(denyIp, req.ip, now) || listed(denyUser, req.user, now)) {
    return { action: 'block', rule_id: DENYLIST, category: 'abuse' };
  }
  for (const { rule, re } of compiled) {
    for (const f of rule.fields) {
      const v = req[f];
      if (!v) continue;
      const m = re.exec(v);
      if (m) {
        return { action: mode === 'block' ? 'block' : 'monitor', rule_id: rule.id, category: rule.category, match: m[0].slice(0, 200) };
      }
    }
  }
  return { action: 'allow' };
}

const decode = (s: string, form = false): string => {
  const x = form ? s.replace(/\+/g, ' ') : s;
  try {
    return decodeURIComponent(x);
  } catch {
    return x;
  }
};

type Headers = Record<string, string | string[] | undefined>;
/** The slice of a Node request the inspector reads. */
export interface NodeRequest {
  url?: string;
  originalUrl?: string;
  headers?: Headers;
  socket?: { remoteAddress?: string };
  body?: unknown;
}
/** The slice of a Node response used to answer 403. */
export interface NodeResponse {
  statusCode: number;
  setHeader?(name: string, value: string): unknown;
  end(body?: string): unknown;
}

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/** Client IP: first `X-Forwarded-For` hop, else `X-Real-IP`, else the socket peer.
 * shortcut: trusts the forwarding headers; run behind a proxy that overwrites them. */
export function clientIp(req: NodeRequest): string | undefined {
  const xff = first(req.headers?.['x-forwarded-for']);
  if (xff) return xff.split(',')[0]!.trim();
  return first(req.headers?.['x-real-ip']) || req.socket?.remoteAddress?.replace(/^::ffff:/, '');
}

/** Decode a Node request into the inspector's fields. */
export function fromNode(req: NodeRequest, user?: string): Inspected {
  const url = req.originalUrl || req.url || '/';
  const q = url.indexOf('?');
  const headers = Object.entries(req.headers || {})
    .filter(([k]) => k !== 'user-agent')
    .map(([, v]) => (Array.isArray(v) ? v.join(', ') : v || ''))
    .join('\n');
  let body: string | undefined;
  if (typeof req.body === 'string') body = req.body.slice(0, BODY_MAX);
  else if (req.body && typeof req.body === 'object') {
    try {
      body = JSON.stringify(req.body).slice(0, BODY_MAX);
    } catch {
      body = undefined;
    }
  }
  return {
    path: decode(q < 0 ? url : url.slice(0, q)),
    query: q < 0 ? '' : decode(url.slice(q + 1), true),
    user_agent: first(req.headers?.['user-agent']) || '',
    headers,
    body,
    ip: clientIp(req),
    user,
  };
}

/** Record a decision on the active span. */
export function annotate(d: Decision, ip?: string): void {
  const span = trace.getActiveSpan();
  if (!span) return;
  if (ip) span.setAttribute('appsec.client_ip', ip);
  if (d.action === 'allow') return;
  span.setAttributes({
    'appsec.event': true,
    'appsec.rule_id': d.rule_id || '',
    'appsec.category': d.category || '',
    'appsec.blocked': d.action === 'block',
  });
}

const PROBLEM = JSON.stringify({
  type: 'about:blank',
  title: 'Forbidden',
  status: 403,
  detail: 'Request blocked by Watchtower App and API Protection',
});

/** Inspect and, when blocked, answer 403. Returns true when the request was answered. */
export function handleRequest(req: NodeRequest, res: NodeResponse, user?: string): boolean {
  if (!compiled.length && !denyIp.size && !denyUser.size) return false;
  const r = fromNode(req, user);
  const d = inspect(r);
  annotate(d, r.ip);
  if (d.action !== 'block') return false;
  res.statusCode = 403;
  res.setHeader?.('content-type', 'application/problem+json');
  res.end(PROBLEM);
  return true;
}

/** Connect-style middleware; `user(req)` names the caller when the app already knows it. */
export function appsecMiddleware(o: { user?: (req: NodeRequest) => string | undefined } = {}) {
  return (req: NodeRequest, res: NodeResponse, next: (err?: unknown) => void): void => {
    if (!handleRequest(req, res, o.user?.(req))) next();
  };
}

/** Mark the current request as a login attempt; failed ones feed the account-takeover rules. */
export function trackLogin(login: string, success: boolean): void {
  const span = trace.getActiveSpan();
  span?.setAttributes({ 'appsec.login': login, 'appsec.login.success': success });
  if (success) span?.setAttribute('appsec.auth', true);
}

export interface AppsecOptions {
  /** API base; default `WT_API_URL` or https://api.watchtower.dev */
  apiUrl?: string;
  /** Ingestion key with scope `probes:read`; default `WT_INGEST_KEY`. */
  key?: string;
  /** Default `WT_SERVICE` or `OTEL_SERVICE_NAME`. */
  service?: string;
  fetch?: typeof fetch;
}

/** Fetch the ruleset now and keep polling; `stop()` ends the polling. */
export function startAppsec(o: AppsecOptions = {}): { ready: Promise<void>; stop(): void } {
  const env = process.env;
  const base = (o.apiUrl || env.WT_API_URL || 'https://api.watchtower.dev').replace(/\/$/, '');
  const key = o.key || env.WT_INGEST_KEY || '';
  const service = o.service || env.WT_SERVICE || env.OTEL_SERVICE_NAME || 'unknown';
  const f = o.fetch || globalThis.fetch;
  let etag = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let pollS = 30;
  const poll = async (): Promise<void> => {
    try {
      const res = await f(`${base}/v1/appsec/ruleset?service=${encodeURIComponent(service)}`, {
        headers: { Authorization: `Bearer ${key}`, ...(etag ? { 'If-None-Match': etag } : {}) },
      });
      if (res.status === 200) {
        const body = (await res.json()) as Ruleset;
        setRuleset(body);
        etag = res.headers.get('etag') || '';
        pollS = Math.max(10, body.poll_s || 30);
      }
    } catch {
      // keep the last ruleset; try again on the next poll
    }
    if (!stopped) {
      timer = setTimeout(() => void poll(), pollS * 1000);
      timer.unref?.();
    }
  };
  return {
    ready: poll(),
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
