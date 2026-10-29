export function requestHandler(): (req: any, res: any, next: (err?: unknown) => void) => void;
export function errorHandler(): (err: unknown, req: any, res: any, next: (err?: unknown) => void) => void;
