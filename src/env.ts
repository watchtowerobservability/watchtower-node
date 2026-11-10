// Standard OTEL_* environment variables, used as fallbacks after the WT_* ones.

/** Parse `k=v,k2=v2` (OTEL_RESOURCE_ATTRIBUTES / OTEL_EXPORTER_OTLP_HEADERS); values are percent-decoded. */
export function parseKv(s: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (s || '').split(',')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const dec = (x: string): string => { try { return decodeURIComponent(x.trim()); } catch { return x.trim(); } };
    out[dec(part.slice(0, i))] = dec(part.slice(i + 1));
  }
  return out;
}

export interface OtelEnv {
  endpoint?: string;
  /** Header names are lower-cased by nobody: they are kept as written, except `Authorization` is matched case-insensitively. */
  headers: Record<string, string>;
  /** `Authorization: Bearer <key>` from OTEL_EXPORTER_OTLP_HEADERS, the key only. */
  bearer?: string;
  serviceName?: string;
  resource: Record<string, string>;
}

export function otelEnv(env: NodeJS.ProcessEnv = process.env): OtelEnv {
  const headers = parseKv(env.OTEL_EXPORTER_OTLP_HEADERS);
  const authKey = Object.keys(headers).find((k) => k.toLowerCase() === 'authorization');
  const auth = authKey ? headers[authKey]! : undefined;
  if (authKey) delete headers[authKey];
  const resource = parseKv(env.OTEL_RESOURCE_ATTRIBUTES);
  return {
    endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT || undefined,
    headers,
    bearer: auth && /^bearer\s+/i.test(auth) ? auth.replace(/^bearer\s+/i, '') : undefined,
    serviceName: env.OTEL_SERVICE_NAME || resource['service.name'] || undefined,
    resource,
  };
}
