#!/usr/bin/env node
// `wt-next-doctor [dir]`: exit 1 when .next/standalone lacks the SDK or an OpenTelemetry peer (see next-doctor.ts).
import { standaloneMissing } from './next-doctor.js';
import { STANDALONE_HINT } from './load.js';

const missing = standaloneMissing(process.argv[2]);
if (!missing) console.log('[watchtower] no .next/standalone found; nothing to check');
else if (missing.length) {
  console.error(`[watchtower] missing from .next/standalone/node_modules: ${missing.join(', ')}\n[watchtower] fix: ${STANDALONE_HINT}`);
  process.exit(1);
} else console.log('[watchtower] standalone build includes the SDK and its OpenTelemetry peers');
