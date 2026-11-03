// Optional-peer loader (winston-transport). This is the CommonJS form; scripts/build.mjs swaps in an ESM twin
// (createRequire(import.meta.url)) for dist/esm. The cwd fallback only matters when neither exists (test runners).
import { createRequire } from 'node:module';

export function load(id: string): unknown {
  if (typeof require === 'function') return require(id);
  return createRequire(`${process.cwd()}/`)(id);
}
