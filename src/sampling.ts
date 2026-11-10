// Remote sampling (S5): poll GET /v1/sampling?service=&env= (ETag, every `intervalMs`) and decide
// at the SDK like the gateway's head rules do (same fnv64 over the trace id, so every service
// agrees on a trace). Until the first answer, and whenever a poll fails, the last good config
// (initially keep everything) stays in force.
import type { Attributes, Context, Link, SpanKind } from '@opentelemetry/api';
import type { Sampler, SamplingResult } from '@opentelemetry/sdk-trace';

const NOT_RECORD = 0;
const RECORD_AND_SAMPLED = 2;
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK = 0xffffffffffffffffn;
const TWO_64 = 18446744073709551616;

export interface SamplingRule {
  name?: string;
  enabled?: boolean | null;
  match?: {
    service?: string; env?: string; span_name_prefix?: string; span_name_glob?: string; span_name_regex?: string;
    attrs?: Record<string, string>; min_duration_ms?: number | null; status?: string;
  };
  action?: { kind?: string; ratio?: number | null };
}
export interface RemoteConfig {
  strategyType?: string;
  probabilisticSampling?: { samplingRate: number };
  rules?: SamplingRule[];
}

/** fnv64a of the trace id's bytes, as a fraction of 2^64; matches the gateway's `ratioKeeps`. */
export function traceFraction(traceIdHex: string): number {
  let h = FNV_OFFSET;
  for (let i = 0; i + 1 < traceIdHex.length; i += 2) h = ((h ^ BigInt(parseInt(traceIdHex.slice(i, i + 2), 16))) * FNV_PRIME) & MASK;
  return Number(h) / TWO_64;
}

export function globMatches(glob: string, text: string): boolean {
  const re = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${re}$`, 's').test(text);
}

function ruleMatches(r: SamplingRule, service: string, env: string, name: string, attrs: Attributes): boolean {
  const m = r.match ?? {};
  // duration and status are only known at the end of the span: the gateway decides those
  if (m.min_duration_ms != null || m.status) return false;
  if ((m.service && m.service !== service) || (m.env && m.env !== env)) return false;
  if (m.span_name_prefix && !name.startsWith(m.span_name_prefix)) return false;
  if (m.span_name_glob && !globMatches(m.span_name_glob, name)) return false;
  if (m.span_name_regex) {
    try { if (!new RegExp(m.span_name_regex).test(name)) return false; } catch { return false; }
  }
  return Object.entries(m.attrs ?? {}).every(([k, v]) => String(attrs[k]) === v);
}

/** The keep ratio for a span under `cfg` (1 = keep). First matching ratio/drop rule wins. */
export function ratioFor(cfg: RemoteConfig, service: string, env: string, name: string, attrs: Attributes): number {
  if (cfg.strategyType === 'PROBABILISTIC') return clamp(cfg.probabilisticSampling?.samplingRate);
  for (const r of cfg.rules ?? []) {
    if (r.enabled === false || !ruleMatches(r, service, env, name, attrs)) continue;
    if (r.action?.kind === 'drop') return 0;
    if (r.action?.kind === 'ratio' && r.action.ratio != null) return clamp(r.action.ratio);
    return 1; // keep, tail, rate: decided later
  }
  return 1;
}

const clamp = (r: number | undefined): number => (typeof r === 'number' && Number.isFinite(r) ? Math.min(1, Math.max(0, r)) : 1);

export interface RemoteSamplerOptions {
  endpoint: string; headers: Record<string, string>; service: string; env?: string;
  intervalMs?: number; fetch?: typeof fetch;
}

export class RemoteSampler implements Sampler {
  cfg: RemoteConfig = {};
  private etag = '';
  private timer?: ReturnType<typeof setInterval>;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly o: RemoteSamplerOptions) {
    this.fetchFn = o.fetch ?? globalThis.fetch;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), Math.max(1000, o.intervalMs ?? 30_000));
    this.timer.unref?.();
  }

  /** One poll; a failure or 304 keeps the current config. */
  async poll(): Promise<void> {
    try {
      const q = new URLSearchParams({ service: this.o.service, ...(this.o.env ? { env: this.o.env } : {}) });
      const res = await this.fetchFn(`${this.o.endpoint}/v1/sampling?${q}`, {
        headers: { ...this.o.headers, ...(this.etag ? { 'If-None-Match': this.etag } : {}) },
      });
      if (res.status === 304 || !res.ok) return;
      this.cfg = (await res.json()) as RemoteConfig;
      this.etag = res.headers.get('ETag') ?? '';
    } catch { /* fallback: keep the last good config */ }
  }

  stop(): void { if (this.timer) clearInterval(this.timer); }

  shouldSample(_c: Context, traceId: string, name: string, _k: SpanKind, attributes: Attributes, _l: Link[]): SamplingResult {
    const r = ratioFor(this.cfg, this.o.service, this.o.env ?? '', name, attributes);
    const keep = r >= 1 || (r > 0 && traceFraction(traceId) < r);
    return { decision: keep ? RECORD_AND_SAMPLED : NOT_RECORD };
  }

  toString(): string { return 'WatchtowerRemoteSampler'; }
}
