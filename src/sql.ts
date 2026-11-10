// Shared SQL normaliser and statement hash. A byte-for-byte port of the worker's
// services/worker/src/sqlnorm.rs (`normalize_with`, xxh3_64), so `db.query.hash` from the SDK equals
// the `wt.db.query_hash` the server stamps. Algorithm: docs/product/instrumentation/sql-normalization.md;
// vectors: testdata/sql_normalize_vectors.json. Change both sides together.

/** Longest statement looked at, in UTF-8 bytes; the rest is dropped. */
export const MAX_STATEMENT_BYTES = 8 * 1024;
const MAX_DOLLAR_TAG = 32;

const ALNUM = /^[\p{Alphabetic}\p{N}]$/u; // Rust char::is_alphanumeric
const SPACE = /^\p{White_Space}$/u; // Rust char::is_whitespace
const isAlnum = (c: string) => ALNUM.test(c);
const isWord = (c: string) => c === '_' || c === '$' || ALNUM.test(c);
const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';

/** Code points of the first 8 KiB of UTF-8, cut back to a whole character. */
function cap(s: string): string[] {
  const out: string[] = [];
  let bytes = 0;
  for (const c of s) {
    const cp = c.codePointAt(0)!;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (bytes > MAX_STATEMENT_BYTES) break;
    out.push(c);
  }
  return out;
}

const startsWith = (cs: string[], at: number, tag: string[]) => tag.every((t, k) => cs[at + k] === t);

function dollarQuoted(cs: string[], i: number): number | undefined {
  let tagLen = -1;
  for (let k = 0; k < MAX_DOLLAR_TAG + 1 && i + 1 + k < cs.length; k++) {
    if (cs[i + 1 + k] === '$') { tagLen = k; break; }
  }
  if (tagLen < 0) return undefined;
  const tag = cs.slice(i, i + tagLen + 2);
  if (!tag.slice(1, tagLen + 1).every((c) => isAlnum(c) || c === '_') || isDigit(tag[1])) return undefined;
  for (let j = i + tag.length; j < cs.length; j++) if (startsWith(cs, j, tag)) return j + tag.length;
  return cs.length;
}

function token(cs: string[], i: number, pg: boolean, out: string[]): number {
  const c = cs[i]!;
  if (c === "'") {
    i++;
    while (i < cs.length) {
      if (cs[i] === "'") {
        if (cs[i + 1] !== "'") break;
        i++;
      }
      i++;
    }
    out.push('?');
    // a quote right after a backslash is ambiguous (MySQL escapes): mask to the end
    return i < cs.length && cs[i - 1] === '\\' ? cs.length : i + 1;
  }
  if (c === '"' || c === '`') {
    let close = cs.indexOf(c, i + 1);
    if (close < 0) close = cs.length;
    const body = cs.slice(i + 1, close);
    const ident = c === '"' && pg && close < cs.length && body.length >= 1 && body.length <= 64
      && body.every((b) => isAlnum(b) || b === '_' || b === '$');
    if (ident) out.push(...cs.slice(i, close + 1));
    else out.push('?');
    return close + 1;
  }
  if (c === '$') {
    if (isDigit(cs[i + 1])) {
      i++;
      while (isDigit(cs[i])) i++;
      out.push('?');
      return i;
    }
    const end = dollarQuoted(cs, i);
    if (end !== undefined) { out.push('?'); return end; }
  }
  if (isDigit(c)) {
    while (i < cs.length && (isWord(cs[i]!) || cs[i] === '.')) i++;
    out.push('?');
  } else if (isWord(c)) {
    while (i < cs.length && isWord(cs[i]!)) out.push(cs[i++]!);
  } else {
    out.push(c);
    i++;
  }
  return i;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const SP = 0x20;

/** After `in`: optional spaces, `(`, `?` items split by commas, `)`. Returns [open, end]. */
function inList(b: Uint8Array, i: number): [number, number] | undefined {
  const skip = () => { while (b[i] === SP) i++; };
  skip();
  const open = i;
  if (b[i] !== 0x28) return undefined;
  i++;
  for (;;) {
    skip();
    if (b[i] !== 0x3f) return undefined;
    i++;
    skip();
    if (b[i] === 0x2c) i++;
    else if (b[i] === 0x29) return [open, i + 1];
    else return undefined;
  }
}

/** `in (?, ?, ?)` -> `in (?+)`. On UTF-8 bytes like the Rust: the word check reads the previous byte as Latin-1. */
function collapseIn(s: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < s.length) {
    const atWord = i === 0 || !isWord(String.fromCharCode(s[i - 1]!));
    const span = atWord && i + 2 <= s.length && (s[i]! | 0x20) === 0x69 && (s[i + 1]! | 0x20) === 0x6e
      ? inList(s, i + 2) : undefined;
    if (span) {
      for (let k = i; k < span[0]; k++) out.push(s[k]!);
      out.push(0x28, 0x3f, 0x2b, 0x29);
      i = span[1];
    } else {
      out.push(s[i++]!);
    }
  }
  return Uint8Array.from(out);
}

function normalizeBytes(stmt: string, pg: boolean): Uint8Array {
  const cs = cap(stmt);
  const out: string[] = [];
  let space = false;
  let i = 0;
  while (i < cs.length) {
    const c = cs[i]!;
    const next = cs[i + 1];
    if (SPACE.test(c)) {
      space = true;
      i++;
    } else if (c === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < cs.length && depth > 0) {
        if (cs[i] === '/' && cs[i + 1] === '*') { depth++; i += 2; }
        else if (cs[i] === '*' && cs[i + 1] === '/') { depth--; i += 2; }
        else i++;
      }
      space = true;
    } else if ((c === '-' && next === '-') || (c === '#' && !pg)) {
      while (i < cs.length && cs[i] !== '\n') i++;
      space = true;
    } else {
      if (space && out.length) out.push(' ');
      space = false;
      i = token(cs, i, pg, out);
    }
  }
  return collapseIn(enc.encode(out.join('')));
}

/**
 * Literal-free statement text: strings, numbers and `$1` become `?`, comments go, whitespace
 * collapses, `IN (?, ?)` becomes `IN (?+)`. `pg` keeps short `"identifiers"` and the `#` operator.
 */
export function normalizeSql(stmt: string, pg = false): string {
  return dec.decode(normalizeBytes(stmt, pg));
}

/** `[normalized text, decimal xxh3_64 of its UTF-8 bytes]`: the `db.query.hash` spans carry. */
export function normalizeAndHash(stmt: string, pg = false): [string, string] {
  const b = normalizeBytes(stmt, pg);
  return [dec.decode(b), xxh3(b).toString()];
}

/** Systems whose dialect keeps `"identifier"` quotes and the `#` operator (as the worker decides). */
export const isPgDialect = (system: string | undefined) =>
  system === 'postgresql' || system === 'cockroachdb' || system === 'redshift';

const OP = /^\s*(?:with\b[\s\S]*?\)\s*)?([a-z]+)/i;
const NAME = '(?:"[^"]+"|[\\w$]+)(?:\\.(?:"[^"]+"|[\\w$]+))?';
const TARGET = new RegExp(`\\b(?:from|into|update|join|table)\\s+(?:if\\s+(?:not\\s+)?exists\\s+)?(${NAME})`, 'i');
// DDL: `CREATE [TEMP|VIRTUAL|UNIQUE...] TABLE|INDEX|VIEW [IF NOT EXISTS] name [ON table]`; an index is named after its table
const CREATE = new RegExp(`^\\s*create\\s+(?:(?:temp|temporary|virtual|unique|fulltext|spatial|clustered|nonclustered|materialized|or\\s+replace)\\s+)*(table|index|view)\\s+(?:if\\s+not\\s+exists\\s+)?(?:concurrently\\s+)?(${NAME})(?:\\s+on\\s+(?:only\\s+)?(${NAME}))?`, 'i');

/** `SELECT users`-style summary: the operation and first table, never values or the statement text. */
export function querySummary(text: string | null | undefined, fallback = 'postgres'): {
  operation?: string; target?: string; summary: string;
} {
  const ddl = text?.match(CREATE);
  if (ddl) {
    const kind = ddl[1]!.toLowerCase();
    const operation = `CREATE ${kind.toUpperCase()}`;
    const target = (kind === 'index' ? ddl[3] ?? ddl[2]! : ddl[2]!).replace(/"/g, '');
    return { operation, target, summary: `${operation} ${target}` };
  }
  const operation = text?.match(OP)?.[1]?.toUpperCase();
  const target = text?.match(TARGET)?.[1]?.replace(/"/g, '');
  return { operation, target, summary: [operation ?? fallback, target].filter(Boolean).join(' ') };
}

// ---- XXH3-64, seed 0, default secret (port of the xxHash reference; BigInt is fine at <= 8 KiB) ----
const M64 = (1n << 64n) - 1n;
const P32_1 = 0x9E3779B1n, P32_2 = 0x85EBCA77n, P32_3 = 0xC2B2AE3Dn;
const P64_1 = 0x9E3779B185EBCA87n, P64_2 = 0xC2B2AE3D27D4EB4Fn, P64_3 = 0x165667B19E3779F9n;
const P64_4 = 0x85EBCA77C2B2AE63n, P64_5 = 0x27D4EB2F165667C5n;
const SECRET = Uint8Array.from(Buffer.from(
  'b8fe6c3923a44bbe7c01812cf721ad1cded46de9839097db7240a4a4b7b3671fcb79e64eccc0e578825ad07dccff7221'
  + 'b8084674f743248ee03590e6813a264c3c2852bb91c300cb88d0658b1b532ea371644897a20df94e3819ef46a9deacd8'
  + 'a8fa763fe39c343ff9dcbbc7c70b4f1d8a51e04bcdb45931c89f7ec9d9787364eac5ac8334d3ebc3c581a0fffa1363eb'
  + '170ddd51b7f0da49d316552629d4689e2b16be587d47a1fc8ff8b8d17ad031ce45cb3a8f95160428afd7fbcabb4b407e', 'hex'));

const r64 = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset + o, 8).getBigUint64(0, true);
const r32 = (b: Uint8Array, o: number) => BigInt(new DataView(b.buffer, b.byteOffset + o, 4).getUint32(0, true));
const mul = (a: bigint, b: bigint) => (a * b) & M64;
const add = (a: bigint, b: bigint) => (a + b) & M64;
const rotl = (x: bigint, r: bigint) => ((x << r) | (x >> (64n - r))) & M64;
const swap64 = (x: bigint) => {
  let r = 0n;
  for (let k = 0; k < 8; k++) { r = (r << 8n) | (x & 0xffn); x >>= 8n; }
  return r;
};
const fold = (a: bigint, b: bigint) => { const p = a * b; return (p ^ (p >> 64n)) & M64; };
const avalanche = (h: bigint) => { h ^= h >> 37n; h = mul(h, 0x165667919E3779F9n); return h ^ (h >> 32n); };
const avalanche64 = (h: bigint) => {
  h ^= h >> 33n; h = mul(h, P64_2); h ^= h >> 29n; h = mul(h, P64_3); return h ^ (h >> 32n);
};
const mix16 = (p: Uint8Array, o: number, s: number) => fold(r64(p, o) ^ r64(SECRET, s), r64(p, o + 8) ^ r64(SECRET, s + 8));

function accumulate512(acc: bigint[], p: Uint8Array, o: number, s: number): void {
  for (let i = 0; i < 8; i++) {
    const v = r64(p, o + 8 * i);
    const k = v ^ r64(SECRET, s + 8 * i);
    acc[i ^ 1] = add(acc[i ^ 1]!, v);
    acc[i] = add(acc[i]!, (k & 0xffffffffn) * (k >> 32n));
  }
}

function long(p: Uint8Array): bigint {
  const len = p.length;
  const acc = [P32_3, P64_1, P64_2, P64_3, P64_4, P32_2, P64_5, P32_1];
  const stripesPerBlock = (SECRET.length - 64) / 8;
  const block = 64 * stripesPerBlock;
  const blocks = Math.floor((len - 1) / block);
  for (let n = 0; n < blocks; n++) {
    for (let s = 0; s < stripesPerBlock; s++) accumulate512(acc, p, n * block + s * 64, s * 8);
    for (let i = 0; i < 8; i++) {
      let a = acc[i]!;
      a ^= a >> 47n;
      a ^= r64(SECRET, SECRET.length - 64 + 8 * i);
      acc[i] = mul(a, P32_1);
    }
  }
  const stripes = Math.floor((len - 1 - block * blocks) / 64);
  for (let s = 0; s < stripes; s++) accumulate512(acc, p, blocks * block + s * 64, s * 8);
  accumulate512(acc, p, len - 64, SECRET.length - 64 - 7);
  let r = mul(BigInt(len), P64_1);
  for (let i = 0; i < 4; i++) r = add(r, fold(acc[2 * i]! ^ r64(SECRET, 11 + 16 * i), acc[2 * i + 1]! ^ r64(SECRET, 19 + 16 * i)));
  return avalanche(r);
}

/** XXH3_64bits(input), seed 0. */
export function xxh3(p: Uint8Array): bigint {
  const len = p.length;
  const L = BigInt(len);
  if (len === 0) return avalanche64(r64(SECRET, 56) ^ r64(SECRET, 64));
  if (len <= 3) {
    const combined = (BigInt(p[0]!) << 16n) | (BigInt(p[len >> 1]!) << 24n) | BigInt(p[len - 1]!) | (L << 8n);
    return avalanche64(combined ^ (r32(SECRET, 0) ^ r32(SECRET, 4)));
  }
  if (len <= 8) {
    const keyed = (r32(p, len - 4) + (r32(p, 0) << 32n)) ^ (r64(SECRET, 8) ^ r64(SECRET, 16));
    let h = keyed ^ rotl(keyed, 49n) ^ rotl(keyed, 24n);
    h = mul(h, 0x9FB21C651E98DF25n);
    h ^= add(h >> 35n, L);
    h = mul(h, 0x9FB21C651E98DF25n);
    return h ^ (h >> 28n);
  }
  if (len <= 16) {
    const lo = r64(p, 0) ^ (r64(SECRET, 24) ^ r64(SECRET, 32));
    const hi = r64(p, len - 8) ^ (r64(SECRET, 40) ^ r64(SECRET, 48));
    return avalanche(add(add(add(L, swap64(lo)), hi), fold(lo, hi)));
  }
  if (len <= 128) {
    let acc = mul(L, P64_1);
    if (len > 32) {
      if (len > 64) {
        if (len > 96) acc = add(add(acc, mix16(p, 48, 96)), mix16(p, len - 64, 112));
        acc = add(add(acc, mix16(p, 32, 64)), mix16(p, len - 48, 80));
      }
      acc = add(add(acc, mix16(p, 16, 32)), mix16(p, len - 32, 48));
    }
    return avalanche(add(add(acc, mix16(p, 0, 0)), mix16(p, len - 16, 16)));
  }
  if (len <= 240) {
    let acc = mul(L, P64_1);
    for (let i = 0; i < 8; i++) acc = add(acc, mix16(p, 16 * i, 16 * i));
    acc = avalanche(acc);
    for (let i = 8; i < Math.floor(len / 16); i++) acc = add(acc, mix16(p, 16 * i, 16 * (i - 8) + 3));
    return avalanche(add(acc, mix16(p, len - 16, 136 - 17)));
  }
  return long(p);
}
