/**
 * abort-utils Unit Tests
 *
 * Covers the two teardown helpers shared across the orchestration layer:
 * - isAbortSentinel: BOTH sentinel forms (bare 'Aborted' from the local abort
 *   races, and the researcher-id-prefixed '<id>: Aborted' thrown by
 *   ensureAssistantResponse for externally-aborted sessions) must classify as
 *   aborts, while provider/user error text that merely mentions "aborted" must
 *   not.
 * - boundSessionAbort: never waits longer than the bound on a wedged
 *   session.abort(), and never fires a stale onTimeout after a settled one.
 */

import { describe, it, expect, vi } from 'vitest';
import { isAbortSentinel, boundSessionAbort, SESSION_ABORT_SETTLE_TIMEOUT_MS } from '../../../src/orchestration/abort-utils.ts';

describe('isAbortSentinel', () => {
  it('matches the bare sentinel thrown by the orchestrator abort races', () => {
    expect(isAbortSentinel('Aborted')).toBe(true);
  });

  it('matches the researcher-id-prefixed sentinel from ensureAssistantResponse', () => {
    // Deep researchers use hierarchical ids; the quick orchestrator labels 'Quick'.
    expect(isAbortSentinel('1: Aborted')).toBe(true);
    expect(isAbortSentinel('1.2: Aborted')).toBe(true);
    expect(isAbortSentinel('Quick: Aborted')).toBe(true);
  });

  it('does NOT match unrelated errors that merely mention aborts', () => {
    expect(isAbortSentinel('Aborted early by the provider')).toBe(false);
    expect(isAbortSentinel('user aborted')).toBe(false);
    expect(isAbortSentinel('1.2: Provider error - request Aborted')).toBe(false);
    expect(isAbortSentinel('ResearcherAborted')).toBe(false);
    expect(isAbortSentinel('')).toBe(false);
  });
});

describe('boundSessionAbort', () => {
  it('resolves as soon as the abort settles, without firing onTimeout', async () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      await boundSessionAbort(Promise.resolve(), onTimeout);
      // Run out the full bound: a settled abort must have cleared its timer so
      // no stale onTimeout can fire later.
      await vi.advanceTimersByTimeAsync(SESSION_ABORT_SETTLE_TIMEOUT_MS + 1);
      expect(onTimeout).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('proceeds after the bound (with onTimeout) when the abort never settles', async () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      const wedged = new Promise<void>(() => { /* never settles */ });
      const bounded = boundSessionAbort(wedged, onTimeout);
      await vi.advanceTimersByTimeAsync(SESSION_ABORT_SETTLE_TIMEOUT_MS + 1);
      await expect(bounded).resolves.toBeUndefined();
      expect(onTimeout).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('honours a caller-supplied bound', async () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      const bounded = boundSessionAbort(new Promise<void>(() => {}), onTimeout, 50);
      await vi.advanceTimersByTimeAsync(51);
      await expect(bounded).resolves.toBeUndefined();
      expect(onTimeout).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
