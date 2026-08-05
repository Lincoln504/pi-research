/**
 * Abort/Teardown Utilities
 *
 * Shared by the orchestration layer for two teardown concerns:
 * - Classifying the "Aborted" sentinel consistently everywhere it is consumed.
 * - Bounding waits on session aborts, which may never settle.
 */

/**
 * Upper bound for awaiting a session abort during cleanup/teardown.
 * session.abort() awaits the very in-flight request it is cancelling, which can
 * be wedged (e.g. a provider retry loop against an exhausted quota) and never
 * settle — so no teardown path may await it unbounded.
 */
export const SESSION_ABORT_SETTLE_TIMEOUT_MS = 10_000;

/**
 * True when an error message is the abort sentinel. Two forms exist and must
 * classify identically:
 * - bare 'Aborted' — thrown by the orchestrators' local abort races, and
 * - '<researcher-id>: Aborted' — thrown by ensureAssistantResponse
 *   (text-utils.ts) when an externally-aborted pi session resolves prompt()
 *   normally with no salvageable text (the fast-stop abortAllSessions path).
 * An exact-equality check misses the prefixed form, which made the executor
 * RETRY a researcher the fast-stop path had just aborted: fresh session, fresh
 * search/scrape burst, sessions re-registered after cleanup already ran.
 */
export function isAbortSentinel(message: string): boolean {
  return /(^|: )Aborted$/.test(message);
}

/**
 * Await an abort (which must never reject — callers attach their own .catch)
 * for at most `timeoutMs`, then proceed with teardown. When the bound fires,
 * `onTimeout` runs (callers log there); the abandoned abort keeps draining in
 * the background and dies with the run's teardown. The timer never keeps the
 * process alive, and is cleared when the abort settles first so it cannot fire
 * a stale onTimeout later.
 */
export async function boundSessionAbort(
  abort: Promise<void>,
  onTimeout: () => void,
  timeoutMs: number = SESSION_ABORT_SETTLE_TIMEOUT_MS,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      abort,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          onTimeout();
          resolve();
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
