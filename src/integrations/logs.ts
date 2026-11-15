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
const MAX_DEPTH = 4;
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
const prim = (v: unknown): boolean => v == null || ['string', 'number', 'boolean'].includes(typeof v);
/** Nested plain objects become dotted attributes (`req.url`) up to depth 4 so `redact` and the presets see each leaf; arrays of primitives stay arrays, anything else is a JSON string. */
const flat = (o: Record<string, unknown>, skip?: Set<string>, prefix = '', depth = 1, attrs: Record<string, unknown> = {}): Record<string, unknown> => {
  for (const [k, v] of Object.entries(o)) {
    if (skip && skip.has(k)) continue;
    const key = prefix + k;
    if (plain(v) && depth < MAX_DEPTH) flat(v, undefined, `${key}.`, depth + 1, attrs);
    else if (Array.isArray(v) && v.every(prim)) attrs[key] = v;
    else attrs[key] = typeof v === 'object' && v !== null ? JSON.stringify(v) : v;
  }
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
