export function instrumentOpenAI<T>(client: T): T;
export function instrumentAnthropic<T>(client: T): T;
export function vercelAiTelemetry(o?: Record<string, unknown>): Record<string, unknown>;
