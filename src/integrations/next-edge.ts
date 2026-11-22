// Edge/browser build of `@watchtowerobservability/node/next` (package.json exports: edge-light, worker, browser).
// Next compiles instrumentation.ts for those runtimes too; the real module pulls Node builtins and fails there. Imports nothing.
type Opts = Record<string, unknown>;

export type NextOptions = Opts;
export type SourcemapOptions = Opts;
export type TunnelOptions = Opts;

/** @deprecated use `@watchtowerobservability/next` */
export const makeRegister = (_options: NextOptions = {}): (() => Promise<void>) => async () => {};
/** @deprecated use `@watchtowerobservability/next` */
export const register = makeRegister();
/** @deprecated use `@watchtowerobservability/next` */
export async function onRequestError(_err?: unknown, _request?: unknown, _context?: unknown): Promise<void> {}
/** @deprecated use `@watchtowerobservability/next` */
export const withWatchtower = <T>(config: T, _opts?: Opts): T => config;
