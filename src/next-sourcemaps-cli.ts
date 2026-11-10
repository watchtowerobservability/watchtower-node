#!/usr/bin/env node
// `wt-next-sourcemaps [dir]`: upload .next/static source maps after `next build` (env: WT_API_KEY, WT_PROJECT, WT_RELEASE, WT_API_URL), then delete them.
import { uploadSourcemaps } from './integrations/next-build.js';

uploadSourcemaps({ dir: process.argv[2], log: (l) => console.log(`[watchtower] ${l}`) }).catch((e: Error) => {
  console.error(`[watchtower] source map upload failed: ${e.message}`);
  process.exit(1);
});
