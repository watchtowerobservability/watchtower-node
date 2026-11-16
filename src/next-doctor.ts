// After `next build` with output 'standalone', check that the SDK and its OpenTelemetry peers were traced into
// .next/standalone/node_modules (npm layout, or pnpm's .pnpm store), then load each one from the standalone server.js
// (wt-next-doctor exits 1 on either failure), so a peer copied without its own dependencies also fails.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { SDK_PEERS, STANDALONE_HINT } from './load.js';

/** Packages missing from `<dir>/.next/standalone/node_modules` (and the app's own, next to server.js); undefined when there is no standalone build. */
export function standaloneMissing(dir = '.'): string[] | undefined {
  const nm = nodePath.join(dir, '.next', 'standalone', 'node_modules');
  if (!fs.existsSync(nodePath.join(dir, '.next', 'standalone'))) return undefined;
  const pnpm = nodePath.join(nm, '.pnpm');
  const store = fs.existsSync(pnpm) ? fs.readdirSync(pnpm) : [];
  const server = standaloneServer(dir); // a monorepo app has its own node_modules next to server.js
  const appNm = server ? nodePath.join(nodePath.dirname(server), 'node_modules') : nm;
  return ['@watchtowerobservability/node', ...SDK_PEERS].filter((id) => !fs.existsSync(nodePath.join(nm, id)) && !fs.existsSync(nodePath.join(appNm, id)) && !store.some((e) => e.startsWith(`${id.replace('/', '+')}@`)));
}

/** The standalone `server.js` (an app in a monorepo sits below `.next/standalone/<path>`); undefined when none. */
export function standaloneServer(dir = '.'): string | undefined {
  const find = (d: string, depth: number): string | undefined => {
    if (fs.existsSync(nodePath.join(d, 'server.js'))) return nodePath.join(d, 'server.js');
    if (depth === 0) return undefined;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const hit = find(nodePath.join(d, e.name), depth - 1);
      if (hit) return hit;
    }
    return undefined;
  };
  const root = nodePath.join(dir, '.next', 'standalone');
  return fs.existsSync(root) ? find(root, 4) : undefined;
}

/**
 * Import the SDK and load each peer the way the server will (from the SDK's location, then from server.js), in a child
 * process; returns `id: error` for each that fails. Catches a peer copied without its own dependencies, which a
 * folder check cannot see.
 */
export function standaloneUnloadable(server: string): string[] {
  const abs = nodePath.resolve(server);
  // ESM, as Next loads the external SDK (its CJS build is not traced); bare specifiers resolve from cwd
  const code = `import { createRequire } from 'node:module'; const app = createRequire(${JSON.stringify(abs)}); const bad = [];
let sdk; try { await import('@watchtowerobservability/node'); sdk = createRequire(import.meta.resolve('@watchtowerobservability/node')); } catch (e) { bad.push('@watchtowerobservability/node: ' + e.message.split('\\n')[0]); }
for (const id of ${JSON.stringify(SDK_PEERS)}) { try { (sdk || app)(id); } catch (e) { try { app(id); } catch { bad.push(id + ': ' + e.message.split('\\n')[0]); } } }
process.stdout.write(JSON.stringify(bad)); process.exit(0);`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], { cwd: nodePath.dirname(abs), encoding: 'utf8' });
  return JSON.parse(out) as string[];
}
