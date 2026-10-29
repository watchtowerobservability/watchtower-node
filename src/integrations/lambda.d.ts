export function wrapHandler<E, R>(handler: (event: E, context: any) => Promise<R>, o?: { name?: string }): (event: E, context: any) => Promise<R>;
