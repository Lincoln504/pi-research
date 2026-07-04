/**
 * Safe unref utility for Node.js timers.
 *
 * Node's setTimeout returns NodeJS.Timeout which has unref(), but some
 * TypeScript configurations don't expose it. This helper avoids the
 * repeated `(timer as any).unref()` pattern.
 */
export function safeUnref(timer: NodeJS.Timeout | null | undefined): void {
  if (timer && typeof (timer as any).unref === 'function') {
    (timer as any).unref();
  }
}

/**
 * Await `promise`, but give up after `deadlineMs` (resolving `undefined`).
 *
 * Unlike a bare `Promise.race([promise, setTimeout])`, the deadline timer is
 * unref'd AND cleared as soon as `promise` settles, so a losing timeout never
 * holds the event loop open after teardown work completes. Rejections of
 * `promise` propagate unchanged (matching Promise.race semantics).
 */
export function raceWithDeadline<T>(promise: Promise<T>, deadlineMs: number): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), deadlineMs);
    safeUnref(timer);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}
