export function pinoStream(client?: { log(level: string, body: string, attrs?: Record<string, unknown>): void }): { write(line: string): void };
export function watchtowerTransport(client?: { log(level: string, body: string, attrs?: Record<string, unknown>): void }): object;
