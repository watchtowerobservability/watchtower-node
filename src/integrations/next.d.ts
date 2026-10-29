export function register(): Promise<void>;
export function onRequestError(err: unknown, request?: { path?: string; method?: string }, context?: { routerKind?: string; routePath?: string; routeType?: string }): Promise<void>;
