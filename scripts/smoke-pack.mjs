// Pack the package, install the tarball into a clean temp project and import every entry through both module systems.
// Needs network for `npm install` (@opentelemetry/api). Run: npm run smoke
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const root = mkdtempSync(join(tmpdir(), 'wt-smoke-'));
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 'inherit', 'inherit'], shell: process.platform === 'win32' });
try {
  const packDir = join(root, 'pack');
  const app = join(root, 'app');
  mkdirSync(packDir);
  mkdirSync(app);
  run(npm, ['pack', '--pack-destination', packDir], process.cwd()); // prepack builds
  const tgz = readdirSync(packDir).find((f) => f.endsWith('.tgz'));
  writeFileSync(join(app, 'package.json'), '{"name":"wt-smoke","private":true}\n');
  run(npm, ['install', '--no-audit', '--no-fund', join(packDir, tgz)], app);
  const entries = ['', '/register', '/next', '/express', '/logs'].map((e) => `@watchtowerobservability/node${e}`);
  const esm = `for (const id of ${JSON.stringify(entries)}) { await import(id); }
    const m = await import('@watchtowerobservability/node'); if (typeof m.init !== 'function') throw new Error('ESM init missing'); console.log('esm ok');`;
  const cjs = `for (const id of ${JSON.stringify(entries)}) require(id);
    if (typeof require('@watchtowerobservability/node').init !== 'function') throw new Error('CJS init missing'); console.log('cjs ok');`;
  run(process.execPath, ['--input-type=module', '-e', esm], app);
  run(process.execPath, ['-e', cjs], app);
} finally {
  rmSync(root, { recursive: true, force: true });
}
