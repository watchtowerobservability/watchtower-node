// Dual build with plain tsc: dist/cjs (CommonJS) and dist/esm (ESM), each with its own .d.ts.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { appendFileSync, rmSync, writeFileSync } from 'node:fs';

const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
rmSync('dist', { recursive: true, force: true });
for (const p of ['tsconfig.cjs.json', 'tsconfig.esm.json']) execFileSync(process.execPath, [tsc, '-p', p], { stdio: 'inherit' });

writeFileSync('dist/cjs/package.json', '{"type":"commonjs"}\n');
writeFileSync('dist/esm/package.json', '{"type":"module"}\n');

// ESM cannot use a bare `require`: resolve the optional peer from this package instead.
writeFileSync('dist/esm/load.js',
  "import { createRequire } from 'node:module';\nconst req = createRequire(import.meta.url);\nexport function load(id) {\n  return req(id);\n}\n");

// The reporters were `module.exports = Class` in CommonJS; keep `require('.../jest')` returning the class.
for (const f of ['jest', 'vitest']) {
  appendFileSync(`dist/cjs/${f}.js`, 'module.exports = Object.assign(exports.default, { default: exports.default });\n');
}
