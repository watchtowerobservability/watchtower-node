// Dual build with plain tsc: dist/cjs (CommonJS) and dist/esm (ESM), each with its own .d.ts.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { appendFileSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { guardPeers, peerSpecs } from './dts-peers.mjs';

const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
rmSync('dist', { recursive: true, force: true });
for (const p of ['tsconfig.cjs.json', 'tsconfig.esm.json']) execFileSync(process.execPath, [tsc, '-p', p], { stdio: 'inherit' });

writeFileSync('dist/cjs/package.json', '{"type":"commonjs"}\n');
writeFileSync('dist/esm/package.json', '{"type":"module"}\n');

// ESM has no __filename, so search the SDK's own location (where npm and pnpm put its dependencies) from import.meta.url,
// wrapped in a call so bundlers do not treat it as a static createRequire (see load.ts).
const loadJs = 'dist/esm/load.js';
const self = "typeof __filename === 'string' ? __filename : ''";
const loadSrc = readFileSync(loadJs, 'utf8');
if (!loadSrc.includes(self)) throw new Error(`${loadJs}: SDK location expression not found`);
writeFileSync(loadJs, loadSrc.replace(self, 'String(new URL(import.meta.url))'));

// Declarations must not break consumers that skip installing an optional peer (TS2307 under skipLibCheck:false).
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const peers = peerSpecs(pkg);
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : e.name.endsWith('.d.ts') ? [`${d}/${e.name}`] : []));
for (const f of [...walk('dist/cjs'), ...walk('dist/esm')]) writeFileSync(f, guardPeers(readFileSync(f, 'utf8'), peers));

// The reporters were `module.exports = Class` in CommonJS; keep `require('.../jest')` returning the class.
for (const f of ['jest', 'vitest']) {
  appendFileSync(`dist/cjs/${f}.js`, 'module.exports = Object.assign(exports.default, { default: exports.default });\n');
}
