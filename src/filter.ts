// Drop spans at export time: `keep` returns false to drop a finished span (used for Next.js internal spans).
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace';

export function filterExporter(inner: SpanExporter, keep: (s: ReadableSpan) => boolean): SpanExporter {
  return {
    export(spans, done) {
      const kept = spans.filter(keep);
      if (kept.length) inner.export(kept, done);
      else done({ code: 0 });
    },
    shutdown: () => inner.shutdown(),
    forceFlush: () => inner.forceFlush?.() ?? Promise.resolve(),
  };
}
