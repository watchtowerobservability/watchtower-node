export function middleware(): (ctx: any, next: () => Promise<unknown>) => Promise<void>;
