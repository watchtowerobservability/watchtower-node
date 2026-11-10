// Code origin (L2): stamp the file, line and function that started a span, as the OTel semconv
// attributes code.filepath, code.lineno and code.function. Opt-in because it captures a stack
// per span. Frames inside node_modules, node: internals and this package are skipped, so the
// first application frame is reported. A span that already carries code.filepath is left alone.
import type { Span } from '@opentelemetry/api';
import type { SpanProcessor } from '@opentelemetry/sdk-trace';

export interface Frame { file: string; line: number; fn?: string }

const FRAME = /^\s*at (?:(.+?) \()?(.+?):(\d+):\d+\)?$/;
const SKIP = /node_modules|^node:|[\\/]watchtower[\\/](?:dist|src)[\\/]|@watchtowerobservability[\\/]node/;

/** The first application frame of a V8 stack, or undefined. */
export function firstAppFrame(stack: string): Frame | undefined {
  for (const line of stack.split('\n').slice(1)) {
    const m = FRAME.exec(line);
    if (!m) continue;
    const file = m[2]!.replace(/^file:\/\//, '');
    if (SKIP.test(file) || SKIP.test(line.trim().slice(3))) continue;
    return { file, line: Number(m[3]), fn: m[1] && m[1] !== '<anonymous>' ? m[1] : undefined };
  }
  return undefined;
}

export function codeOrigin(): SpanProcessor {
  return {
    onStart(span) {
      const s = span as unknown as Span & { attributes?: Record<string, unknown> };
      if (s.attributes?.['code.filepath'] !== undefined) return;
      const holder: { stack?: string } = {};
      const prev = Error.stackTraceLimit;
      Error.stackTraceLimit = 30;
      Error.captureStackTrace(holder);
      Error.stackTraceLimit = prev;
      const f = firstAppFrame(holder.stack ?? '');
      if (!f) return;
      s.setAttribute('code.filepath', f.file);
      s.setAttribute('code.lineno', f.line);
      if (f.fn) s.setAttribute('code.function', f.fn);
    },
    onEnd() {},
    shutdown: () => Promise.resolve(),
    forceFlush: () => Promise.resolve(),
  };
}
