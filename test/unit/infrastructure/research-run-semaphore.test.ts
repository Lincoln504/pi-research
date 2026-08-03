/**
 * ResearchRunSemaphore — cross-process run-cap unit tests.
 *
 * These exercise the slot coordination using real FileLockService instances on
 * real temp files. "Cross-instance" tests use two semaphore instances pointing at
 * the SAME slot dir, which is exactly what cross-process coordination reduces to
 * (distinct instances, shared slot files) — so they genuinely cover the
 * acquire/no-steal-live/exhaust/reclaim logic that matters in production.
 *
 * PID-reuse-safe liveness is exercised in bare-PID mode (no processLifecycle
 * injected): FileLockService falls back to signal(0), and a fake dead-owner file
 * with an out-of-range PID reads as dead and is reclaimed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../src/logger.ts', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));
vi.mock('../../../src/utils/metrics.ts', () => ({
  metrics: { increment: vi.fn(), setGauge: vi.fn(), observe: vi.fn() },
}));

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as pathmod from 'node:path';
import { ResearchRunSemaphore, ResearchRunCapacityError } from '../../../src/infrastructure/research-run-semaphore.ts';

/** A PID guaranteed not to exist (far beyond any real pid_max) → signal(0) → ESRCH → dead. */
const DEAD_PID = 2147483647;

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(pathmod.join(os.tmpdir(), 'rrs-test-'));
}

/** Write a fake owner lock at a slot path (simulates a prior holder). */
async function writeSlotLock(slotDir: string, index: number, pid: number, uuid = `owner-${index}`): Promise<void> {
  await fs.writeFile(
    pathmod.join(slotDir, `research-run-slot-${index}.lock`),
    JSON.stringify({ uuid, pid }),
  );
}

describe('ResearchRunSemaphore', () => {
  let dirs: string[] = [];

  beforeEach(() => {
    dirs = [];
  });

  afterEach(async () => {
    await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => {})));
  });

  async function newSemaphore(maxSlots = 2, maxWaitMs = 0): Promise<{ sem: ResearchRunSemaphore; dir: string }> {
    const dir = await makeTempDir();
    dirs.push(dir);
    const sem = new ResearchRunSemaphore(dir, null, maxSlots, maxWaitMs);
    await sem.initialize();
    return { sem, dir };
  }

  it('acquires and releases a single slot', async () => {
    const { sem } = await newSemaphore(1);
    const a = await sem.acquire();
    expect(a.slotIndex).toBe(0);
    await a.release();
    // After release, a second acquire succeeds again on the same slot.
    const b = await sem.acquire();
    expect(b.slotIndex).toBe(0);
    await b.release();
  });

  it('allows up to N concurrent acquisitions with independent handles (no shared-state corruption)', async () => {
    const { sem } = await newSemaphore(2);
    const a = await sem.acquire();
    const b = await sem.acquire();
    expect(a.slotIndex).not.toBe(b.slotIndex);
    expect(new Set([a.slotIndex, b.slotIndex])).toEqual(new Set([0, 1]));
    // Releasing one must not affect the other's slot.
    await a.release();
    // The freed slot is now reusable; the still-held slot is not.
    const c = await sem.acquire();
    expect(c.slotIndex).toBe(a.slotIndex);
    await b.release();
    await c.release();
  });

  it('fails fast with ResearchRunCapacityError when all slots are held by live processes (maxWait=0)', async () => {
    const { sem } = await newSemaphore(2);
    const a = await sem.acquire();
    const b = await sem.acquire();
    await expect(sem.acquire(0)).rejects.toBeInstanceOf(ResearchRunCapacityError);
    // The error carries the slot count.
    await expect(sem.acquire(0)).rejects.toMatchObject({ slots: 2 });
    await a.release();
    await b.release();
  });

  it('does NOT steal a slot held by a live owner, even under contention (cross-instance = cross-process)', async () => {
    // Two semaphore instances on the SAME dir simulate two OS processes sharing slot files.
    const dir = await makeTempDir();
    dirs.push(dir);
    const s1 = new ResearchRunSemaphore(dir, null, 2, 0);
    const s2 = new ResearchRunSemaphore(dir, null, 2, 0);
    await s1.initialize();
    await s2.initialize();

    const a = await s1.acquire(); // s1 grabs a slot
    const b = await s2.acquire(); // s2 must take the OTHER slot, not steal a's
    expect(a.slotIndex).not.toBe(b.slotIndex);

    // A third acquisition (s1) finds both slots live-held → exhausted.
    await expect(s1.acquire(0)).rejects.toBeInstanceOf(ResearchRunCapacityError);

    await a.release();
    await b.release();
  });

  it('reclaims a slot whose owner process has died (crash recovery during acquire)', async () => {
    const { sem, dir } = await newSemaphore(1);
    // Simulate a crashed prior holder: a dead-PID lock at slot 0.
    await writeSlotLock(dir, 0, DEAD_PID);
    // The dead slot is reclaimed immediately (regardless of age) and acquired.
    const a = await sem.acquire();
    expect(a.slotIndex).toBe(0);
    await a.release();
  });

  it('reclaims a dead owner even when other live slots are also held (picks the freeable slot)', async () => {
    const dir = await makeTempDir();
    dirs.push(dir);
    const s1 = new ResearchRunSemaphore(dir, null, 2, 0);
    await s1.initialize();
    // s1 holds slot 0 (live). Slot 1 has a dead owner.
    const held = await s1.acquire();
    expect(held.slotIndex).toBe(0);
    await writeSlotLock(dir, 1, DEAD_PID);

    const s2 = new ResearchRunSemaphore(dir, null, 2, 0);
    await s2.initialize();
    // s2 must NOT steal slot 0 (live) but MUST reclaim slot 1 (dead).
    const b = await s2.acquire();
    expect(b.slotIndex).toBe(1);
    await held.release();
    await b.release();
  });

  it('honors a positive maxWaitMs, waiting until a slot is freed', async () => {
    const { sem } = await newSemaphore(1, 5000);
    const a = await sem.acquire();
    // Free the slot shortly; the contended acquire should then succeed, not time out.
    setTimeout(() => { void a.release(); }, 150);
    const b = await sem.acquire();
    expect(b.slotIndex).toBe(0);
    await b.release();
  });

  it('times out with ResearchRunCapacityError after maxWaitMs if nothing frees', async () => {
    const { sem } = await newSemaphore(1, 120);
    const a = await sem.acquire();
    const start = Date.now();
    await expect(sem.acquire()).rejects.toBeInstanceOf(ResearchRunCapacityError);
    expect(Date.now() - start).toBeGreaterThanOrEqual(100); // actually waited
    await a.release();
  });

  it('respects the configured maxSlots (cap of 1 allows only one holder)', async () => {
    const { sem } = await newSemaphore(1);
    const a = await sem.acquire();
    await expect(sem.acquire(0)).rejects.toBeInstanceOf(ResearchRunCapacityError);
    await a.release();
  });

  it('release is idempotent (double-release is a no-op)', async () => {
    const { sem } = await newSemaphore(1);
    const a = await sem.acquire();
    await a.release();
    await expect(a.release()).resolves.toBeUndefined();
    // Slot is still usable.
    const b = await sem.acquire();
    await b.release();
  });

  it('clears the held-slot gauge on release', async () => {
    // A gauge that only ever ratchets to 1 reports permanent saturation for the
    // life of the process, which is worse than not publishing it at all.
    const { metrics } = await import('../../../src/utils/metrics.ts');
    const setGauge = vi.mocked(metrics.setGauge);
    setGauge.mockClear();

    const { sem } = await newSemaphore(1);
    const a = await sem.acquire();
    expect(setGauge).toHaveBeenCalledWith('research_run_slots_held', 1, { slot: '0' });
    await a.release();
    expect(setGauge).toHaveBeenCalledWith('research_run_slots_held', 0, { slot: '0' });
  });

  describe('cancellation', () => {
    it('rejects immediately when the signal is already aborted', async () => {
      const { sem } = await newSemaphore(1, 60_000);
      await expect(sem.acquire(undefined, AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('aborts a wait in progress instead of sitting out the full timeout', async () => {
      // With a long acquire timeout the wait happens before any orchestrator exists,
      // so this is the only place a Ctrl-C during queueing can be honoured.
      const { sem } = await newSemaphore(1, 60_000);
      const held = await sem.acquire();
      const controller = new AbortController();
      const start = Date.now();
      const pending = sem.acquire(undefined, controller.signal);
      setTimeout(() => controller.abort(), 100);

      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      expect(Date.now() - start).toBeLessThan(5_000); // nowhere near the 60s deadline
      await held.release();
    });
  });
});
