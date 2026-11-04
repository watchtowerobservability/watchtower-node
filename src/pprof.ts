// Minimal pprof (profile.proto) encoder, no dependency: folded stacks in, gzipped protobuf out.
import { gzipSync } from 'node:zlib';

/** Protobuf writer for the handful of field shapes profile.proto needs. */
class Pb {
  readonly b: number[] = [];
  private varint(x: number | bigint): void {
    let n = BigInt(x);
    while (n > 127n) {
      this.b.push(Number(n & 127n) | 128);
      n >>= 7n;
    }
    this.b.push(Number(n));
  }
  int(field: number, v: number | bigint): this {
    if (v) {
      this.varint(field << 3);
      this.varint(v);
    }
    return this;
  }
  bytes(field: number, data: ArrayLike<number>): this {
    this.varint((field << 3) | 2);
    this.varint(data.length);
    for (let i = 0; i < data.length; i++) this.b.push(data[i]!);
    return this;
  }
  msg(field: number, m: Pb): this {
    return this.bytes(field, m.b);
  }
  packed(field: number, vs: number[]): this {
    const p = new Pb();
    for (const v of vs) p.varint(v);
    return this.bytes(field, p.b);
  }
}

/**
 * Folded stacks (`[span_id=…,trace_id=…\t]a;b;c` root first, as `foldProfile` makes them) to a
 * gzipped pprof with sample types samples/count and cpu/nanoseconds. The `k=v` prefix becomes
 * sample labels. Frame names keep their `(file:line)` suffix; one function per distinct frame.
 */
export function foldedToPprof(counts: Map<string, number>, periodNs: number, startMs: number, durationMs: number): Uint8Array {
  const strings = [''];
  const index = new Map<string, number>([['', 0]]);
  const s = (x: string): number => {
    let i = index.get(x);
    if (i === undefined) {
      i = strings.length;
      strings.push(x);
      index.set(x, i);
    }
    return i;
  };
  const vt = (type: string, unit: string): Pb => new Pb().int(1, s(type)).int(2, s(unit));
  const frames = new Map<string, number>();
  const out = new Pb().msg(1, vt('samples', 'count')).msg(1, vt('cpu', 'nanoseconds'));
  for (const [key, n] of counts) {
    const tab = key.indexOf('\t');
    const labels = tab >= 0 ? key.slice(0, tab) : '';
    // pprof location ids are leaf first
    const ids = key.slice(tab + 1).split(';').reverse().map((f) => {
      let id = frames.get(f);
      if (id === undefined) frames.set(f, (id = frames.size + 1));
      return id;
    });
    const sample = new Pb().packed(1, ids).packed(2, [n, n * periodNs]);
    for (const kv of labels ? labels.split(',') : []) {
      const eq = kv.indexOf('=');
      if (eq > 0) sample.msg(3, new Pb().int(1, s(kv.slice(0, eq))).int(2, s(kv.slice(eq + 1))));
    }
    out.msg(2, sample);
  }
  for (const [f, id] of frames) {
    out.msg(4, new Pb().int(1, id).msg(4, new Pb().int(1, id))); // Location{id, line[{function_id}]}
    out.msg(5, new Pb().int(1, id).int(2, s(f))); // Function{id, name}
  }
  out.int(9, BigInt(Math.round(startMs)) * 1_000_000n).int(10, BigInt(Math.round(durationMs)) * 1_000_000n);
  out.msg(11, vt('cpu', 'nanoseconds')).int(12, periodNs);
  for (const str of strings) out.bytes(6, Buffer.from(str));
  return new Uint8Array(gzipSync(Uint8Array.from(out.b)));
}
