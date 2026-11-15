#!/usr/bin/env node
// `wt-next-sourcemaps [--inject] [dir]`: upload .next/static source maps after `next build` (env: WT_API_KEY, WT_PROJECT, WT_RELEASE, WT_API_URL), then delete them. `--inject` first writes a debug id into every chunk and map.
import { uploadSourcemaps } from './integrations/next-build.js';

const args = process.argv.slice(2);
uploadSourcemaps({ dir: args.find((a) => !a.startsWith('--')), inject: args.includes('--inject'), log: (l) => console.log(`[watchtower] ${l}`) }).then((r) => { if (r.failed > 0) process.exit(1); }).catch((e: Error) => {
  console.error(`[watchtower] source map upload failed: ${e.message}`);
  process.exit(1);
});
