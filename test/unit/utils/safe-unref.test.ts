/**
 * raceWithDeadline: the bounded-await helper used on teardown paths
 * (BrowserTaskScheduler.shutdown, WorkerPoolManager.shutdown,
 * SchedulerService.dispose). Regression for lingering ref'd timers: a bare
 * Promise.race([p, setTimeout(...)]) left the losing 2s/5s/10s/15s timer
 * active after clean teardown, holding the event loop open. The helper must
 * clear (not just unref) the deadline timer as soon as the promise settles.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { raceWithDeadline, safeUnref } from '../../../src/utils/safe-unref.ts';

describe('raceWithDeadline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves with the promise value and clears the deadline timer', async () => {
    const result = raceWithDeadline(Promise.resolve('done'), 15_000);
    await expect(result).resolves.toBe('done');
    // The losing timer must be cleared, not left pending for 15s.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('propagates rejection and clears the deadline timer', async () => {
    const result = raceWithDeadline(Promise.reject(new Error('boom')), 15_000);
    await expect(result).rejects.toThrow('boom');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolves undefined once the deadline elapses', async () => {
    const never = new Promise<string>(() => {});
    const result = raceWithDeadline(never, 5_000);
    const flag = { settled: false };
    result.then(() => { flag.settled = true; });

    await vi.advanceTimersByTimeAsync(4_999);
    expect(flag.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBeUndefined();
  });

  it('clears the timer when a delayed promise wins the race', async () => {
    let resolveIt!: (v: string) => void;
    const slow = new Promise<string>((res) => { resolveIt = res; });
    const result = raceWithDeadline(slow, 10_000);

    await vi.advanceTimersByTimeAsync(1_000);
    resolveIt('late-but-in-time');
    await expect(result).resolves.toBe('late-but-in-time');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('safeUnref', () => {
  it('tolerates null/undefined and timer objects without unref', () => {
    expect(() => safeUnref(null)).not.toThrow();
    expect(() => safeUnref(undefined)).not.toThrow();
    expect(() => safeUnref({} as any)).not.toThrow();
  });
});
