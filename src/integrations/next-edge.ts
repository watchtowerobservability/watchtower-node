// Edge/browser build of `@watchtowerobservability/node/next` (package.json exports: edge-light, worker, browser).
// Next compiles instrumentation.ts for those runtimes too; the real module pulls Node builtins and fails there. Imports nothing.
type Opts = Record<string, unknown>;

export type NextOptions = Opts;
export type SourcemapOptions = Opts;
export type TunnelOptions = Opts;

export const makeRegister = (_options: NextOptions = {}): (() => Promise<void>) => async () => {};
export const register = makeRegister();
export async function onRequestError(_err?: unknown, _request?: unknown, _context?: unknown): Promise<void> {}
export const withWatchtower = <T>(config: T, _opts?: Opts): T => config;
