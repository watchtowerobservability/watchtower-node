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

// ESM needs no shim: load.ts falls back to a createRequire() that bundlers cannot follow (see load.ts), so webpack neither
// warns about the missing optional peers nor flags a critical dependency.

// Declarations must not break consumers that skip installing an optional peer (TS2307 under skipLibCheck:false).
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const peers = peerSpecs(pkg);
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : e.name.endsWith('.d.ts') ? [`${d}/${e.name}`] : []));
for (const f of [...walk('dist/cjs'), ...walk('dist/esm')]) writeFileSync(f, guardPeers(readFileSync(f, 'utf8'), peers));

// The reporters were `module.exports = Class` in CommonJS; keep `require('.../jest')` returning the class.
for (const f of ['jest', 'vitest']) {
  appendFileSync(`dist/cjs/${f}.js`, 'module.exports = Object.assign(exports.default, { default: exports.default });\n');
}
