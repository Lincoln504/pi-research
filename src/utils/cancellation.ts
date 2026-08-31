/**
 * Cancellation detection shared by the agent-facing tools.
 *
 * Every tool wrapper is built to never throw: a failure becomes prose the agent
 * reads and acts on. That contract is right for a failure and wrong for a
 * cancellation, because the prose is written to explain a *fault* — "this may be
 * due to API rate limiting", "unable to search security databases, try again
 * later", "may be due to network issues or YouTube bot-protection". When the user
 * presses Ctrl-C, the in-flight work rejects with an abort and those sentences are
 * simply false. The agent believes them: it retries, spends budget the user just
 * asked it to stop spending, and can carry the invented cause into the report.
 *
 * A cancellation must therefore propagate. The run is ending either way, and the
 * throw is what unwinds the agent loop instead of feeding it a fabricated fault.
 */

/**
 * True when `error` represents the abort of `signal` (or an abort in general)
 * rather than a genuine failure of the work.
 *
 * The message-shape check is the load-bearing part in practice. Cancellation
 * crosses several layers here — worker IPC, HTTP to the browser leader, the
 * research orchestrator's own abort plumbing — and only some of them preserve
 * `AbortError` as the error name; the rest arrive as a plain Error whose message
 * is the reason string. `signal.aborted` alone is not sufficient either: a tool
 * may be handed no signal at all, and a signal can abort after the failure it is
 * being asked to explain.
 */
export function isCancellation(error: unknown, signal?: AbortSignal | null): boolean {
  if (signal?.aborted) return true;
  if (error instanceof Error && error.name === 'AbortError') return true;
  const message = error instanceof Error ? error.message : String(error);
  return /^(aborted|(?:the|this) operation was aborted|research (aborted|cancelled|canceled)|operation cancelled|operation canceled)\.?$/i.test(
    message.trim(),
  );
}

/**
 * Race `op` against `signal`, resolving `undefined` when the signal fires
 * first. The LOSER keeps running in the background — this is an abandon, not
 * a cancel: the op must be safe to leave draining (probes with their own
 * timeouts, best-effort telemetry) and its eventual result or rejection is
 * dropped. Callers treating abandonment as "skip the work" keep their abort
 * handling at the next signal-aware await, exactly where the rest of the run's
 * abort plumbing expects it.
 *
 * The listener is hoisted (defined once, removed in `finally`) so a settled
 * race can never leak an `abort` listener onto a long-lived run signal — the
 * same hygiene the orchestrators' capacity-wait races apply.
 */
export function raceWithSignal<T>(op: Promise<T>, signal?: AbortSignal | null): Promise<T | undefined> {
  if (!signal) return op.then((v) => v);
  if (signal.aborted) {
    // The op was started eagerly and may still REJECT later; without a handler
    // attached that rejection surfaces as an unhandledRejection even though the
    // race already resolved. Swallow it — abandonment drops the outcome by
    // contract (the op must be safe to leave draining).
    void op.catch(() => {});
    return Promise.resolve(undefined);
  }
  let onAbort: () => void;
  const abandoned = new Promise<undefined>((resolve) => {
    onAbort = () => resolve(undefined);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([op, abandoned]).finally(() => {
    signal.removeEventListener('abort', onAbort!);
  });
}
