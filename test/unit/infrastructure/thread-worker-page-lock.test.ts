/**
 * createPageSafe() — page-creation mutex vs. its own 60s timeout.
 *
 * Regression: the lock (see its own doc comment — Playwright/Firefox can
 * deadlock if newPage() is called concurrently on the same context) used to
 * release in an outer `finally` that ran as soon as the internal
 * Promise.race([pagePromise, timeout]) settled — including when the timeout
 * won. That let the NEXT queued caller start its OWN newPage() while the
 * FIRST caller's newPage() was still pending in the background: exactly the
 * concurrent-newPage() scenario the lock exists to prevent, and it happens
 * precisely when the browser is already under the stress that causes 60s+
 * page-creation stalls. The fix ties release to the underlying newPage()
 * promise itself settling, independent of the timeout race's outcome.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPageSafe } from '../../../src/infrastructure/browser/thread-worker-messaging.ts';

describe('createPageSafe — mutex release timing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not let a queued caller start newPage() while the timed-out prior call is still pending', async () => {
    let resolveFirstPage!: (page: unknown) => void;
    const firstPagePromise = new Promise((resolve) => { resolveFirstPage = resolve; });
    const contextA = { newPage: vi.fn(() => firstPagePromise) };

    const firstCall = createPageSafe(contextA);
    // Suppress the unhandled-rejection warning for the eventual timeout —
    // asserted properly below.
    firstCall.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);

    const contextB = { newPage: vi.fn(async () => ({ id: 'page-b' })) };
    const secondCall = createPageSafe(contextB);

    // Advance past the 60s timeout: firstCall's own race rejects with the
    // timeout error, but contextA.newPage() (firstPagePromise) is still
    // unsettled.
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(firstCall).rejects.toThrow('Browser page creation timed out after 60000ms');

    // The mutex must still be held: the second caller must NOT have started
    // its own newPage() yet, because the first call's underlying newPage()
    // promise has not actually settled.
    expect(contextB.newPage).not.toHaveBeenCalled();

    // Only once the first page actually resolves does the lock release.
    resolveFirstPage({ id: 'page-a' });
    await vi.advanceTimersByTimeAsync(0);
    expect(contextB.newPage).toHaveBeenCalledTimes(1);

    const secondPage = await secondCall;
    expect(secondPage).toEqual({ id: 'page-b' });
  });

  it('releases promptly on the ordinary (non-timeout) path so queued callers are not delayed', async () => {
    const contextA = { newPage: vi.fn(async () => ({ id: 'page-a' })) };
    const contextB = { newPage: vi.fn(async () => ({ id: 'page-b' })) };

    const firstPage = await createPageSafe(contextA);
    expect(firstPage).toEqual({ id: 'page-a' });

    const secondPage = await createPageSafe(contextB);
    expect(secondPage).toEqual({ id: 'page-b' });
  });
});
