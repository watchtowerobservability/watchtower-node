// After `next build` with output 'standalone', check that the SDK and its OpenTelemetry peers were traced into
// .next/standalone/node_modules (npm layout, or pnpm's .pnpm store). Exits 1 when any is missing.
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { SDK_PEERS, STANDALONE_HINT } from './load.js';

/** Packages missing from `<dir>/.next/standalone/node_modules`; undefined when there is no standalone build. */
export function standaloneMissing(dir = '.'): string[] | undefined {
  const nm = nodePath.join(dir, '.next', 'standalone', 'node_modules');
  if (!fs.existsSync(nodePath.join(dir, '.next', 'standalone'))) return undefined;
  const pnpm = nodePath.join(nm, '.pnpm');
  const store = fs.existsSync(pnpm) ? fs.readdirSync(pnpm) : [];
  return ['@watchtowerobservability/node', ...SDK_PEERS].filter((id) => !fs.existsSync(nodePath.join(nm, id)) && !store.some((e) => e.startsWith(`${id.replace('/', '+')}@`)));
}
