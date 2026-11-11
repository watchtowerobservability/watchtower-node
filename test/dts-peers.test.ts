import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
// @ts-expect-error plain .mjs helper shared with scripts/build.mjs
import { guardPeers, peerSpecs, unguarded } from '../scripts/dts-peers.mjs';

const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'));
const peers: string[] = peerSpecs(pkg);

test('guardPeers marks every optional-peer specifier and leaves @opentelemetry/api alone', () => {
  const dts = [
    "import type { Tracer } from '@opentelemetry/api';",
    "import type { SpanExporter } from '@opentelemetry/sdk-trace';",
    'export type X = typeof import("@opentelemetry/sdk-logs");',
  ].join('\n');
  expect(unguarded(dts, peers)).toHaveLength(2);
  const out = guardPeers(dts, peers);
  expect(unguarded(out, peers)).toEqual([]);
  expect(out.match(/@ts-ignore/g)).toHaveLength(2);
  expect(guardPeers(out, peers)).toBe(out); // idempotent
});

test('built declarations (when dist exists) never name an optional peer unguarded', () => {
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.d.ts') ? [join(d, e.name)] : []));
  for (const dir of ['dist/cjs', 'dist/esm'].map((d) => join(__dirname, '..', d)).filter(existsSync)) {
    for (const f of walk(dir)) expect(unguarded(readFileSync(f, 'utf8'), peers), f).toEqual([]);
  }
});
