// Filter for Next.js's own internal spans (`nextInternals` option of init / makeRegister).
import { SpanStatusCode } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace';

const KEEP_TYPES = new Set([
  'BaseServer.handleRequest', 'AppRouteRouteHandlers.runHandler', 'AppRender.fetch', 'AppRender.getBodyResult',
  'Render.getServerSideProps', 'Render.getStaticProps', 'NextNodeServer.runApi',
]);
const KEEP_NAMES = /^(render route|executing api route|fetch |.*server action)/i;

/** Whether `span` is one of Next's internal spans (not a request, route handler, render, server action or fetch). */
export function isNextInternal(span: ReadableSpan): boolean {
  const type = span.attributes['next.span_type'];
  if (typeof type !== 'string') return false;
  return !KEEP_TYPES.has(type) && !KEEP_NAMES.test(span.name) && span.kind !== 1 && span.kind !== 2 && span.status.code !== SpanStatusCode.ERROR;
}

/** The `spanFilter` for a `nextInternals` mode; `rand` is injectable for tests. */
export function nextInternalsFilter(mode: 'drop' | 'sample' | 'keep' = 'sample', rate = 0.1, rand: () => number = Math.random): (s: ReadableSpan) => boolean {
  return (s) => mode === 'keep' || !isNextInternal(s) || (mode === 'sample' && rand() < rate);
}
