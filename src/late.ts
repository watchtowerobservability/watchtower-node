// "Loaded too late" detector. Import this FIRST in the entry modules (register.ts, index.ts): ES imports evaluate in order, so
// the snapshot below is taken before the SDK's own dependencies load anything. Under `node --import .../register` nothing
// but Node's bootstrap has run yet, so http/https are absent from process.moduleLoadList (checked on Node 26).
/** Which of http/https are in `list` (default: this process's loaded builtins). */
export const lateModules = (
  list: readonly string[] = (process as unknown as { moduleLoadList?: string[] }).moduleLoadList ?? [],
): string[] =>
  ['http', 'https'].filter((m) => list.includes(`NativeModule ${m}`));

const early = lateModules();
const KEY = Symbol.for('watchtower.node.late-warned');

export const LATE_HINT = 'Start node with --import @watchtowerobservability/node/register';

/** Prints once per process (global flag, so the CJS and ESM copies share it). */
export function warnLate(mods: string[], out: (m: string) => void = (m) => console.warn(m)): void {
  const g = globalThis as Record<symbol, unknown>;
  if (!mods.length || g[KEY]) return;
  g[KEY] = true;
  out(`[watchtower] loaded too late: ${mods[0]} was already imported, so its requests are not traced. ${LATE_HINT}`);
}

/** Under Next (it loads http before instrumentation runs, and its own tracing covers it) or a test runner the check is
 * meaningless. A standalone `server.js` sets __NEXT_PRIVATE_STANDALONE_CONFIG but not NEXT_RUNTIME. */
export const lateCheckApplies = (env: NodeJS.ProcessEnv = process.env, viaNext = false): boolean =>
  !(viaNext || env.NEXT_RUNTIME || env.__NEXT_PRIVATE_STANDALONE_CONFIG || env.NODE_ENV === 'test' || env.VITEST);

/** The entry points call this; `viaNext` when started through a Next entry point (makeRegister, register). */
export function checkLate(viaNext = false): void {
  if (lateCheckApplies(process.env, viaNext)) warnLate(early);
}
