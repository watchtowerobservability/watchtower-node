// Coexistence with another OpenTelemetry setup (Sentry, a vendor agent): find the tracer provider already registered
// globally and add our span processors to it instead of replacing it.
import { trace } from '@opentelemetry/api';

/** The real provider behind the global proxy, or undefined when none (or only the no-op one) is registered. */
export function foreignProvider(): any {
  const g = trace.getTracerProvider() as any;
  const d = typeof g?.getDelegate === 'function' ? g.getDelegate() : g;
  return !d || d.constructor?.name === 'NoopTracerProvider' || d.constructor?.name === 'ProxyTracerProvider' ? undefined : d;
}

/**
 * Add processors to `provider`: `addSpanProcessor` (sdk-trace v1) or the v2 `_activeSpanProcessor._spanProcessors` list.
 * shortcut: v2+ has no public hook, so this reaches into a private field; replace when the SDK adds one.
 */
export function attachProcessors(provider: any, procs: unknown[]): boolean {
  if (typeof provider.addSpanProcessor === 'function') { for (const p of procs) provider.addSpanProcessor(p); return true; }
  const list = provider._activeSpanProcessor?._spanProcessors;
  if (!Array.isArray(list)) return false;
  list.push(...procs);
  return true;
}
