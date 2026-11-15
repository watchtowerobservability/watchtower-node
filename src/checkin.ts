// Cron / scheduler check-ins: POST /v1/checkins/{slug} (key scope `ingest:checkins`; the edge accepts 6 a minute per monitor).
import { withMonitor } from './cron/monitor.js';
export interface CheckinTarget { endpoint: string; headers: Record<string, string>; fetch: typeof fetch }

/** Send `in_progress`, run `fn`, then send `ok` or `error` with its duration. Check-in failures never affect `fn`; its result or error is passed through. */
export function checkin<T>(c: CheckinTarget, slug: string, fn: () => T | Promise<T>): Promise<T> {
  return withMonitor(c, slug, fn, { wait: true });
}
