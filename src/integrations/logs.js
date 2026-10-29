'use strict';
// Logs bridges: pino and winston records become OTLP logs carrying the active trace and span ids.
const wt = require('../index');

const PINO = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' };
const CORE = new Set(['level', 'time', 'msg', 'pid', 'hostname', 'v']);
const flat = (o, skip) => {
  const attrs = {};
  for (const [k, v] of Object.entries(o)) if (!skip || !skip.has(k)) attrs[k] = typeof v === 'object' ? JSON.stringify(v) : v;
  return attrs;
};

/** pino(opts, pinoStream()) or pino.multistream([{ stream: pinoStream() }, { stream: process.stdout }]). */
function pinoStream(client) {
  return {
    write(line) {
      let r;
      try { r = JSON.parse(line); } catch (_) { return; }
      (client || wt).log(PINO[r.level] || 'info', r.msg || '', flat(r, CORE));
    },
  };
}

const WINSTON = { silly: 'trace', debug: 'debug', verbose: 'debug', http: 'info', info: 'info', warn: 'warn', error: 'error' };

/** logger.add(watchtowerTransport()). Needs `winston-transport`, which winston always installs. */
function watchtowerTransport(client) {
  const Transport = require('winston-transport');
  return new (class extends Transport {
    log(info, cb) {
      const { level, message, ...rest } = info;
      (client || wt).log(WINSTON[level] || 'info', String(message), flat(rest));
      cb();
    }
  })();
}

module.exports = { pinoStream, watchtowerTransport };
