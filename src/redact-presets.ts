// Built-in redaction presets for the `redact` option. Rule names mirror the server's (go/internal/redact patterns.go
// `sensitiveKeys`, pii.go kinds `email`, `phone`, `card` (Luhn), `ipv4`, `ipv6`): the gateway applies its own rules again
// as a backstop, so a miss here is still caught there. URLs are handled by scrub.ts (query dropped, token-shaped segments).
import type { RedactHook } from './redact.js';

export type RedactPreset = 'strict' | 'pii' | 'off';
export const REDACTED = '[redacted]';

/** Attribute keys whose string values are secrets: the server's list plus session, credential, private key. */
const SECRET_KEY = /(?:^|[._-])(?:authorization|cookie|set-cookie|password|passwd|pwd|secret|token|api[-_]?key|session|sid|credential|private[-_]?key)(?:$|[._-])/i;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const PHONE = /\+\d{1,3}[ .-]?\(?\d{2,4}\)?[ .-]?\d{3,4}[ .-]?\d{3,4}\b/g;
const CARD = /\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{1,7}\b/g;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const IPV6 = /\b(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}\b|\b(?:[0-9A-Fa-f]{1,4}:){1,6}:(?:[0-9A-Fa-f]{1,4}:){0,5}[0-9A-Fa-f]{1,4}\b/g;

/** Luhn checksum over the digits of `s` (13 to 19 digits). */
export function luhn(s: string): boolean {
  const d = s.replace(/\D/g, '');
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = d.charCodeAt(d.length - 1 - i) - 48;
    if (i % 2 === 1 && (n *= 2) > 9) n -= 9;
    sum += n;
  }
  return sum % 10 === 0;
}

/** Replace emails, phone numbers, Luhn-valid card numbers and IP addresses in free text with `[redacted:<kind>]`. */
export function scrubPii(s: string): string {
  return s
    .replace(EMAIL, '[redacted:email]')
    .replace(CARD, (m) => (luhn(m) ? '[redacted:card]' : m))
    .replace(PHONE, '[redacted:phone]')
    .replace(IPV4, (m) => (m.split('.').every((o) => Number(o) <= 255) ? '[redacted:ipv4]' : m))
    .replace(IPV6, '[redacted:ipv6]');
}

/** True for attribute keys that carry secrets (`http.request.header.authorization`, `db.password`, `x-api-key`); `gen_ai.*` token counters and types are not. */
export const isSecretKey = (k: string): boolean => !k.startsWith('gen_ai.') && SECRET_KEY.test(k);

/** The hook for a preset, or undefined for `off`. Only strings (and arrays of strings) are touched; numbers and booleans pass. */
export function presetHook(level: RedactPreset | undefined): RedactHook | undefined {
  if (level === 'off') return undefined;
  const pii = level === 'pii';
  const hook: RedactHook = (k, v) => {
    if (Array.isArray(v)) return v.map((x) => hook(k, x));
    if (typeof v !== 'string') return v;
    if (isSecretKey(k)) return REDACTED;
    return pii ? scrubPii(v) : v;
  };
  return hook;
}

/** `redact` option -> the combined hook: the preset first (default `strict`), then the user's function. */
export function resolveRedact(opt: RedactHook | RedactPreset | undefined): { preset: RedactPreset; hook: RedactHook | undefined } {
  const preset: RedactPreset = typeof opt === 'string' ? opt : 'strict';
  const user = typeof opt === 'function' ? opt : undefined;
  const base = presetHook(preset);
  if (!user) return { preset, hook: base };
  return { preset, hook: base ? (k, v) => user(k, base(k, v)) : user };
}
