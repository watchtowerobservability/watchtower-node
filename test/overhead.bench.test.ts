import { describe, expect, it } from 'vitest';
import { startProfiling } from '../src/profiling.js';

// Opt-in: skipped in the normal suite. Run: WT_BENCH=1 npx vitest run test/overhead.bench.test.ts
// Measures process CPU time (user+system) of a CPU-bound loop with and without the profiler sampling
// at its default 100 Hz. Uploads (once per 60 s) are outside the timed window.
const run = process.env.WT_BENCH === '1' ? describe : describe.skip;
const MAX_PCT = Number(process.env.WT_BENCH_MAX_PCT ?? 2);
const ROUNDS = Number(process.env.WT_BENCH_ROUNDS ?? 5);
const WORK_MS = Number(process.env.WT_BENCH_WORK_MS ?? 2000);

function work(): number {
  const end = Date.now() + WORK_MS;
  let h = 0;
  while (Date.now() < end) for (let i = 0; i < 1e5; i++) h = (h * 31 + i) | 0;
  return h;
}

/** Iterations per CPU second: a fixed-time loop, so overhead shows as fewer iterations. */
function rate(): number {
  const end = Date.now() + WORK_MS;
  const c0 = process.cpuUsage();
  let n = 0;
  let h = 0;
  while (Date.now() < end) { for (let i = 0; i < 1e5; i++) h = (h * 31 + i) | 0; n++; }
  const c = process.cpuUsage(c0);
  return (n + (h & 0)) / ((c.user + c.system) / 1e6);
}

run('profiler overhead (WT_PROFILING=1)', () => {
  it('costs less than WT_BENCH_MAX_PCT percent CPU on a CPU-bound loop', async () => {
    work(); // warm up the JIT
    const off: number[] = [];
    const on: number[] = [];
    for (let r = 0; r < ROUNDS; r++) {
      off.push(rate());
      const q = await startProfiling({ service: 'bench', endpoint: 'http://127.0.0.1:9', apiKey: 'wti_bench', periodMs: 3_600_000 });
      on.push(rate());
      await q.stop().catch(() => undefined);
    }
    const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
    const pct = (100 * (med(off) - med(on))) / med(off);
    console.log(`profiler overhead: ${pct.toFixed(2)}% (median of ${ROUNDS} rounds, ${WORK_MS} ms each; ${med(off).toFixed(1)} -> ${med(on).toFixed(1)} iterations per CPU second)`);
    expect(pct).toBeLessThan(MAX_PCT);
  }, 120_000);
});
