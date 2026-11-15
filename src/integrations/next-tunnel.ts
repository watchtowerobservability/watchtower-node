// First-party tunnel for browser telemetry (ad blockers block third-party telemetry hosts).
// app/api/wt/[...path]/route.ts:  export const { GET, POST } = tunnelHandler({ endpoint: process.env.WT_EDGE_URL! });
// Browser SDK: init({ endpoint: '/api/wt', publishableKey: 'wtp_...' }).

export interface TunnelOptions {
  /** Edge base URL the requests are forwarded to. */
  endpoint: string;
  /** Route prefix to strip; default `/api/wt`. */
  basePath?: string;
  /** Request body cap in bytes; default 1 MiB (over it: 413). */
  maxBodyBytes?: number;
  /**
   * Only forward beacons whose publishable key is one of these (`?k=` or a `wtp_` bearer); others get 403. Stops
   * a third party from using your tunnel as a relay for another project's key.
   */
  allowKey?: string | string[];
  fetch?: typeof fetch;
}

// only what the browser SDK calls: /v1/rum/*, /v1/replay/<session>/chunks /v1/logs and /v1/traces
const ALLOWED = /^\/v1\/(rum\/[A-Za-z0-9/_-]+|replay\/[A-Za-z0-9_-]+\/chunks|logs|traces)$/;
// `origin` / `referer`: the edge refuses a browser key without an Origin on the key's allowed origins (403 origin_not_allowed),
// so the tunnel passes through the visitor's own Origin: add your site's origin to the key's allowed origins.
const FORWARD = ['content-type', 'content-encoding', 'user-agent', 'origin', 'referer', 'x-wt-sdk', 'x-wt-mask'];

/** Next route handlers `{ GET, POST }` forwarding allow-listed RUM paths to the edge. Only the publishable key (`?k=` or a `wtp_` bearer) is forwarded as auth, plus the visitor's `Origin`/`Referer` (the edge checks the Origin against the key's allowed origins); cookies and other headers are not. */
export function tunnelHandler(o: TunnelOptions): { GET: (r: Request) => Promise<Response>; POST: (r: Request) => Promise<Response> } {
  const base = (o.basePath ?? '/api/wt').replace(/\/+$/, '');
  const max = o.maxBodyBytes ?? 1024 * 1024;
  const edge = o.endpoint.replace(/\/+$/, '');
  const allow = o.allowKey === undefined ? [] : ([] as string[]).concat(o.allowKey);
  const send = o.fetch ?? fetch;
  const handle = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname.startsWith(base) ? url.pathname.slice(base.length) : url.pathname;
    if (!ALLOWED.test(path) || path.includes('..')) return new Response('not found', { status: 404 });
    const headers: Record<string, string> = {};
    for (const h of FORWARD) { const v = req.headers.get(h); if (v) headers[h] = v; }
    if (!headers.origin && headers.referer) { // same-origin GETs carry no Origin: use the Referer's
      try { headers.origin = new URL(headers.referer).origin; } catch { /* not a URL: forward as is */ }
    }
    const bearer = /^Bearer (wtp_\S+)$/.exec(req.headers.get('authorization') ?? '');
    if (bearer) headers.authorization = `Bearer ${bearer[1]}`;
    const k = url.searchParams.get('k');
    if (allow.length && ![k, bearer?.[1]].some((x) => x && allow.includes(x))) return new Response('forbidden', { status: 403 });
    let body: ArrayBuffer | undefined;
    if (req.method === 'POST') {
      if (Number(req.headers.get('content-length') ?? 0) > max) return new Response('payload too large', { status: 413 });
      body = await req.arrayBuffer();
      if (body.byteLength > max) return new Response('payload too large', { status: 413 });
    }
    try {
      const res = await send(`${edge}${path}${k ? `?k=${encodeURIComponent(k)}` : ''}`, { method: req.method, headers, body });
      const out = new Headers();
      const ct = res.headers.get('content-type');
      if (ct) out.set('content-type', ct);
      return new Response(res.status === 204 ? null : await res.arrayBuffer(), { status: res.status, headers: out });
    } catch {
      return new Response('bad gateway', { status: 502 });
    }
  };
  return { GET: handle, POST: handle };
}
