/**
 * Tests for isEmbeddingLeaderAlive — the PID-reuse-safe liveness check the embedding
 * factory uses to decide whether a persisted leader entry still refers to a live
 * process.
 *
 * The defect this guards against: the leader was tracked by PID alone, so if a leader
 * died mid-model-init (its state entry still carries the sentinel port -1, so the port
 * probe is skipped) and the OS recycled its PID to an unrelated live process, a bare
 * signal-0 check would treat the dead leader as still alive and every waiter would spin
 * the full poll timeout. Pairing the PID with the recorded start-time defeats that.
 */

import { describe, it, expect } from 'vitest';
import { isEmbeddingLeaderAlive } from '../../../src/infrastructure/embedding/embedding-factory.ts';
import { ProcessLifecycleService } from '../../../src/infrastructure/process-lifecycle-service.ts';

/**
 * A fake that models an OS process table (pid -> start-time of the process currently
 * holding that pid). isProcessAlive mirrors ProcessLifecycleService semantics: signal-0
 * liveness (pid present) AND, when an expected start-time is supplied, it must equal the
 * live process's start-time (a mismatch means the pid was recycled).
 */
function fakeLifecycle(table: Map<number, number>) {
  return {
    isProcessAlive: async (pid: number, expected?: number | null): Promise<boolean> => {
      if (!table.has(pid)) return false; // ESRCH — no such process
      if (expected === undefined || expected === null) return true; // bare signal-0 check
      return table.get(pid) === expected; // start-time must match the live process
    },
  };
}

describe('isEmbeddingLeaderAlive — liveness contract', () => {
  it('reports a live leader whose recorded start-time matches as alive', async () => {
    const lc = fakeLifecycle(new Map([[100, 5]]));
    expect(await isEmbeddingLeaderAlive({ pid: 100, startTime: 5 }, lc)).toBe(true);
  });

  it('reports a recycled PID (same live pid, different start-time) as dead', async () => {
    // The original leader (pid 100, start 5) died; the OS gave pid 100 to an unrelated
    // process that started later (start 9). The recorded start-time no longer matches.
    const recycled = fakeLifecycle(new Map([[100, 9]]));

    // Correct: with the recorded start-time the recycled pid is seen as NOT the leader.
    expect(await isEmbeddingLeaderAlive({ pid: 100, startTime: 5 }, recycled)).toBe(false);

    // Contrast — proving the fix matters: a bare check with no start-time is fooled,
    // because the pid IS alive (just a different process). This is the old behavior.
    expect(await isEmbeddingLeaderAlive({ pid: 100 }, recycled)).toBe(true);
  });

  it('reports a fully dead pid as not alive', async () => {
    const empty = fakeLifecycle(new Map());
    expect(await isEmbeddingLeaderAlive({ pid: 100, startTime: 5 }, empty)).toBe(false);
  });

  it('falls back to a bare liveness check for a legacy entry with no start-time', async () => {
    // Entries written before start-time was recorded omit it; liveness must still work.
    const lc = fakeLifecycle(new Map([[100, 5]]));
    expect(await isEmbeddingLeaderAlive({ pid: 100 }, lc)).toBe(true);
  });
});

describe('isEmbeddingLeaderAlive — with the real ProcessLifecycleService', () => {
  const svc = new ProcessLifecycleService();

  it('treats the live current process with its true start-time as alive', async () => {
    const start = await svc.getProcessStartTime(process.pid);
    if (start === null) return; // platform cannot read start-time; nothing to assert
    expect(await isEmbeddingLeaderAlive({ pid: process.pid, startTime: start }, svc)).toBe(true);
  });

  it('reports the current pid with a WRONG recorded start-time as dead (PID-reuse defense)', async () => {
    const start = await svc.getProcessStartTime(process.pid);
    if (start === null) return;
    // Same live pid, but a start-time that could not belong to it → treated as a
    // recycled pid, i.e. not the process we recorded.
    expect(await isEmbeddingLeaderAlive({ pid: process.pid, startTime: start + 1_000_000 }, svc)).toBe(false);
  });

  it('falls back to bare liveness for the current pid when no start-time is recorded', async () => {
    expect(await isEmbeddingLeaderAlive({ pid: process.pid }, svc)).toBe(true);
  });

  it('reports a pid that is not running as not alive', async () => {
    // 0x3fffffff is far above any real pid; signal-0 throws ESRCH before start-time is read.
    expect(await isEmbeddingLeaderAlive({ pid: 0x3fffffff, startTime: 123 }, svc)).toBe(false);
  });
});
