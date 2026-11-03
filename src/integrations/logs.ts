// Logs bridges: pino and winston records become OTLP logs carrying the active trace and span ids.
import * as wt from '../index.js';
import type { LogLevel } from '../index.js';
import { load } from '../load.js';

interface TransportBase {}

/** Anything with a `log` method, e.g. a `Client`. */
export interface LogSink {
  log(level: string, body: string, attrs?: Record<string, unknown>): void;
}
const defaultSink: LogSink = { log: (level, body, attrs) => wt.log(level as LogLevel, body, attrs) };

const PINO: Record<number, LogLevel> = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' };
const CORE = new Set(['level', 'time', 'msg', 'pid', 'hostname', 'v']);
const flat = (o: Record<string, unknown>, skip?: Set<string>): Record<string, unknown> => {
  const attrs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (!skip || !skip.has(k)) attrs[k] = typeof v === 'object' ? JSON.stringify(v) : v;
  return attrs;
};

/** pino(opts, pinoStream()) or pino.multistream([{ stream: pinoStream() }, { stream: process.stdout }]). */
export function pinoStream(client?: LogSink): { write(line: string): void } {
  return {
    write(line) {
      let r: Record<string, unknown>;
      try { r = JSON.parse(line); } catch (_) { return; }
      (client || defaultSink).log(PINO[r.level as number] || 'info', (r.msg as string) || '', flat(r, CORE));
    },
  };
}

const WINSTON: Record<string, LogLevel> = { silly: 'trace', debug: 'debug', verbose: 'debug', http: 'info', info: 'info', warn: 'warn', error: 'error' };

/** logger.add(watchtowerTransport()). Needs `winston-transport`, which winston always installs. */
export function watchtowerTransport(client?: LogSink): object {
  const Transport = load('winston-transport') as new (opts?: unknown) => TransportBase;
  return new (class extends Transport {
    log(info: { level: string; message: unknown; [k: string]: unknown }, cb: () => void): void {
      const { level, message, ...rest } = info;
      (client || defaultSink).log(WINSTON[level] || 'info', String(message), flat(rest));
      cb();
    }
  })();
}
