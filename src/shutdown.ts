// Flush on SIGTERM / SIGINT without changing how the process ends.

export interface SignalProc {
  on(event: string, l: () => void): unknown;
  off(event: string, l: () => void): unknown;
  listenerCount(event: string): number;
  kill(pid: number, signal: string): unknown;
  readonly pid: number;
}

/**
 * On SIGTERM and SIGINT: flush (at most `timeoutMs`). Adding a signal listener turns off Node's default exit, so when
 * ours is the only listener it removes itself and re-sends the signal after the flush; when the app or a framework
 * (`next start`) has its own handler, that handler decides how the process ends and ours only starts the flush.
 * Returns the uninstall function.
 */
export function installSignalFlush(flush: () => Promise<unknown>, timeoutMs = 2000, proc: SignalProc = process as unknown as SignalProc): () => void {
  const handlers = new Map<string, () => void>();
  for (const sig of ['SIGTERM', 'SIGINT']) {
    const h = (): void => {
      const alone = proc.listenerCount(sig) <= 1;
      const done = Promise.race([flush().catch(() => undefined), new Promise((r) => setTimeout(r, timeoutMs).unref())]);
      if (!alone) return;
      void done.finally(() => { proc.off(sig, h); proc.kill(proc.pid, sig); });
    };
    handlers.set(sig, h);
    proc.on(sig, h);
  }
  return () => { for (const [sig, h] of handlers) proc.off(sig, h); };
}
