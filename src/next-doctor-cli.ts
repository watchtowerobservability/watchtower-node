#!/usr/bin/env node
// `wt-next-doctor [dir]`: exit 1 when .next/standalone lacks the SDK or an OpenTelemetry peer, or one of them does not
// load from the standalone server.js (see next-doctor.ts).
import { standaloneMissing, standaloneServer, standaloneUnloadable } from './next-doctor.js';
import { STANDALONE_HINT } from './load.js';

const dir = process.argv[2];
const missing = standaloneMissing(dir);
const server = missing && !missing.length ? standaloneServer(dir) : undefined;
const broken = server ? standaloneUnloadable(server) : [];
if (!missing) console.log('[watchtower] no .next/standalone found; nothing to check');
else if (missing.length) {
  console.error(`[watchtower] missing from .next/standalone/node_modules: ${missing.join(', ')}\n[watchtower] fix: ${STANDALONE_HINT}`);
  process.exit(1);
} else if (broken.length) {
  console.error(`[watchtower] present but failing to load from ${server}:\n  ${broken.join('\n  ')}\n[watchtower] fix: ${STANDALONE_HINT}`);
  process.exit(1);
} else console.log(`[watchtower] standalone build includes the SDK and its OpenTelemetry peers${server ? ', and they load' : ''}`);
