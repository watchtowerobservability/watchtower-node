// The `redact` hook applied to everything a span carries, not only its attributes.
import type { AttributeValue } from '@opentelemetry/api';
import type { SpanProcessor } from '@opentelemetry/sdk-trace';

export type RedactHook = (key: string, value: unknown) => unknown;

/** Hook keys for the non-attribute fields. Event attributes (incl. exception.message / exception.stacktrace) use their own keys. */
export const SPAN_NAME_KEY = 'span.name';
export const STATUS_MESSAGE_KEY = 'status.message';
export const LOG_BODY_KEY = 'log.body';

function attrs(a: Record<string, unknown> | undefined, hook: RedactHook): void {
  if (!a) return;
  for (const k of Object.keys(a)) a[k] = hook(k, a[k]) as AttributeValue;
}

/** Assign, falling back to defineProperty if the SDK exposes the field as a getter. */
function put(o: object, k: string, v: unknown): void {
  try { (o as Record<string, unknown>)[k] = v; } catch { /* readonly accessor */ }
  if ((o as Record<string, unknown>)[k] !== v) Object.defineProperty(o, k, { value: v, configurable: true, enumerable: true, writable: true });
}

/** Span processor that redacts the name, status message, attributes, every event's and link's attributes before export. */
export function redactor(hook: RedactHook): SpanProcessor {
  return {
    onStart() {},
    onEnd(span) {
      // ReadableSpan fields are readonly in the types but are plain mutable fields on the SDK span
      const s = span as unknown as { name: string; status: { message?: string }; events: { attributes?: Record<string, unknown> }[]; links: { attributes?: Record<string, unknown> }[] };
      put(s, 'name', String(hook(SPAN_NAME_KEY, s.name) ?? ''));
      if (s.status?.message) put(s.status, 'message', String(hook(STATUS_MESSAGE_KEY, s.status.message) ?? ''));
      attrs(span.attributes as Record<string, unknown>, hook);
      for (const e of s.events || []) attrs(e.attributes, hook);
      for (const l of s.links || []) attrs(l.attributes, hook);
    },
    shutdown: () => Promise.resolve(),
    forceFlush: () => Promise.resolve(),
  };
}
