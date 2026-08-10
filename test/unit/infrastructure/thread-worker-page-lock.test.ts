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

  it('rejects further calls on the SAME context while a hard-release-freed newPage() is still pending, then allows them again once it settles', async () => {
    // Regression: the 5-minute hard-release timer force-frees the mutex even
    // when newPage() is merely slow (not permanently hung). Pre-fix, the very
    // next queued caller would start its OWN newPage() on the SAME context
    // while the first was still in flight — the exact concurrent-newPage()
    // condition this lock exists to prevent. The fix marks the context
    // "wedged" instead: further calls on that context fail fast (no second
    // newPage() call) until the stuck call actually settles.
    let resolveFirstPage!: (page: unknown) => void;
    const firstPagePromise = new Promise((resolve) => { resolveFirstPage = resolve; });
    const contextA = { newPage: vi.fn(() => firstPagePromise) };

    const firstCall = createPageSafe(contextA);
    firstCall.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);

    // Past the 60s soft timeout, firstCall's own race rejects, but the
    // underlying contextA.newPage() call is still unsettled in the background.
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(firstCall).rejects.toThrow('Browser page creation timed out after 60000ms');

    // Cross the 5-minute hard-release bound.
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 - 60_000);

    // A queued call on the SAME context must be rejected fast, without ever
    // calling newPage() a second time.
    await expect(createPageSafe(contextA)).rejects.toThrow(/wedged/i);
    expect(contextA.newPage).toHaveBeenCalledTimes(1);

    // A call on a DIFFERENT context is unaffected — the wedge is scoped to contextA.
    const contextB = { newPage: vi.fn(async () => ({ id: 'page-b' })) };
    await expect(createPageSafe(contextB)).resolves.toEqual({ id: 'page-b' });

    // Once the stuck call actually settles, contextA is no longer wedged.
    resolveFirstPage({ id: 'page-a-late' });
    await vi.advanceTimersByTimeAsync(0);

    await expect(createPageSafe(contextA)).resolves.toEqual({ id: 'page-a-late' });
    expect(contextA.newPage).toHaveBeenCalledTimes(2);
  });
});
