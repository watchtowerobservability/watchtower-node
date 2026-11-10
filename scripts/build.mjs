// Dual build with plain tsc: dist/cjs (CommonJS) and dist/esm (ESM), each with its own .d.ts.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
rmSync('dist', { recursive: true, force: true });
for (const p of ['tsconfig.cjs.json', 'tsconfig.esm.json']) execFileSync(process.execPath, [tsc, '-p', p], { stdio: 'inherit' });

writeFileSync('dist/cjs/package.json', '{"type":"commonjs"}\n');
writeFileSync('dist/esm/package.json', '{"type":"module"}\n');

// ESM has no bare `require`. Each peer is imported with a LITERAL `await import()` inside try (bundlers such as esbuild and
// webpack follow those; a createRequire() result they cannot), results are cached, and the sync `require` that load.js
// calls reads the cache. A missing optional peer stays missing: its error is rethrown as MODULE_NOT_FOUND on first use.
const esmLoad = 'dist/esm/load.js';
const imp = "import { createRequire } from 'node:module';\n";
const src = readFileSync(esmLoad, 'utf8');
if (!src.includes(imp)) throw new Error('dist/esm/load.js: createRequire import not found');
const ids = [...new Set([...src.matchAll(/return require\('([^']+)'\)/g)].map((m) => m[1]))];
if (ids.length < 10) throw new Error('dist/esm/load.js: peer list not found');
const pre = ids.map((id) => `try { pre[${JSON.stringify(id)}] = await import(${JSON.stringify(id)}); } catch (e) { pre[${JSON.stringify(id)}] = e; }`).join('\n');
const shim = `${imp}const pre = {};
${pre}
const nodeRequire = createRequire(import.meta.url);
const require = (id) => {
  const m = pre[id];
  if (m === undefined) return nodeRequire(id);
  if (m instanceof Error) throw Object.assign(new Error(m.message), { code: m.code === 'ERR_MODULE_NOT_FOUND' ? 'MODULE_NOT_FOUND' : m.code });
  return m.default && typeof m.default === 'object' ? { ...m.default, ...m } : m;
};
`;
writeFileSync(esmLoad, src.replace(imp, shim));

// The reporters were `module.exports = Class` in CommonJS; keep `require('.../jest')` returning the class.
for (const f of ['jest', 'vitest']) {
  appendFileSync(`dist/cjs/${f}.js`, 'module.exports = Object.assign(exports.default, { default: exports.default });\n');
}
