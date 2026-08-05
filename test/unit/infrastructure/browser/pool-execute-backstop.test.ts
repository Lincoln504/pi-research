/**
 * executePoolTaskWithDeathBackstop — the pool-side bound on pool.execute().
 *
 * poolifier (measured on 5.3.2) never settles an in-flight execute() whose
 * worker dies: not on the worker's exit, not when a replacement respawns, not
 * even on pool.destroy(). The worker enforces taskTimeoutMs on itself only
 * while it is alive — so without a caller-side bound, an OOM-killed worker
 * left the dispatched closure pending forever, permanently pinning a
 * PriorityTaskQueue concurrency slot. Enough such deaths and the machine-wide
 * leader served nothing but timeouts.
 *
 * The backstop's timer lives INSIDE the dispatched closure, sharing no
 * lifetime with the caller's outer race — the shared-timer variant is exactly
 * how a queued task once lost its guard when the outer race settled first.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  executePoolTaskWithDeathBackstop,
  WORKER_DEATH_BACKSTOP_GRACE_MS,
} from '../../../../src/infrastructure/browser/browser-task-scheduler.ts';

afterEach(() => {
  vi.useRealTimers();
});

describe('executePoolTaskWithDeathBackstop', () => {
  it('rejects a never-settling execute() once the worker budget plus grace elapses', async () => {
    vi.useFakeTimers();
    const taskTimeoutMs = 1000;
    const p = executePoolTaskWithDeathBackstop(() => new Promise<never>(() => {}), taskTimeoutMs, 'Search');
    const rejection = expect(p).rejects.toThrow(
      `Search task unanswered after ${taskTimeoutMs + WORKER_DEATH_BACKSTOP_GRACE_MS}ms — worker likely died mid-task`,
    );
    await vi.advanceTimersByTimeAsync(taskTimeoutMs + WORKER_DEATH_BACKSTOP_GRACE_MS);
    await rejection;
  });

  it('passes a resolution through untouched (and does not fire later)', async () => {
    vi.useFakeTimers();
    const result = await executePoolTaskWithDeathBackstop(async () => ({ ok: 1 }), 50, 'Scrape');
    expect(result).toEqual({ ok: 1 });
    // The timer was cleared on settle: advancing past the backstop window must
    // not produce an unhandled rejection.
    await vi.advanceTimersByTimeAsync(50 + WORKER_DEATH_BACKSTOP_GRACE_MS + 1000);
  });

  it('propagates a live worker error as-is — the backstop only speaks when nothing else can', async () => {
    await expect(
      executePoolTaskWithDeathBackstop(async () => { throw new Error('boom from worker'); }, 50, 'Healthcheck'),
    ).rejects.toThrow('boom from worker');
  });
});
