import { test, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MAX_STATEMENT_BYTES, normalizeAndHash, normalizeSql, querySummary, xxh3 } from '../src/sql.js';

interface Vector { name: string; input: string; pg: boolean; normalized: string; hash: string }
// Shared with the Rust normaliser (services/worker/src/sqlnorm.rs): the same file must pass there.
const { vectors } = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../testdata/sql_normalize_vectors.json'), 'utf8')) as {
  vectors: Vector[];
};

test.each(vectors)('vector: $name', (v) => {
  expect(normalizeAndHash(v.input, v.pg)).toEqual([v.normalized, v.hash]);
  expect(normalizeSql(v.input, v.pg)).toBe(v.normalized);
});

test('xxh3 of the empty input is the reference constant', () => {
  expect(xxh3(new Uint8Array())).toBe(0x2d06800538d394c2n);
});

test('bounded and total on huge or hostile input', () => {
  const big = "SELECT 'é' + 12 IN (1,2) ".repeat(45_000);
  const t = Date.now();
  const [n] = normalizeAndHash(big);
  expect(Date.now() - t).toBeLessThan(2000);
  expect(Buffer.byteLength(n)).toBeLessThanOrEqual(MAX_STATEMENT_BYTES);
  const nested = '$a$'.repeat(5000) + 'in ('.repeat(2000);
  for (const junk of ['', "'", '/*', '--', '$', '$$', 'IN (', 'in(?', "\u{1F600}'\u{1F600}", nested]) {
    expect(typeof normalizeAndHash(junk)[1]).toBe('string');
  }
});

test('summary comes from normalised text and carries no values', () => {
  const [n] = normalizeAndHash("SELECT * FROM users WHERE email = 'a@b.c'");
  expect(querySummary(n, 'sqlite')).toEqual({ operation: 'SELECT', target: 'users', summary: 'SELECT users' });
  expect(querySummary(null, 'sqlite').summary).toBe('sqlite');
});
