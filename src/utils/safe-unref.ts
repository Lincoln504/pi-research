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
