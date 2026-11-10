// Cron / scheduler check-ins: POST /v1/checkins/{slug} (key scope `ingest:checkins`; the edge accepts 6 a minute per monitor).
export interface CheckinTarget { endpoint: string; headers: Record<string, string>; fetch: typeof fetch }

/** Send `in_progress`, run `fn`, then send `ok` or `error` with its duration. Check-in failures never affect `fn`; its result or error is passed through. */
export async function checkin<T>(c: CheckinTarget, slug: string, fn: () => T | Promise<T>): Promise<T> {
  const send = (status: string, ms?: number) =>
    c.fetch(`${c.endpoint}/v1/checkins/${encodeURIComponent(slug)}?status=${status}${ms === undefined ? '' : `&duration_ms=${Math.min(ms, 86_400_000)}`}`,
      { method: 'POST', headers: c.headers }).catch(() => undefined);
  await send('in_progress');
  const t = Date.now();
  try {
    const r = await fn();
    await send('ok', Date.now() - t);
    return r;
  } catch (e) {
    await send('error', Date.now() - t);
    throw e;
  }
}
