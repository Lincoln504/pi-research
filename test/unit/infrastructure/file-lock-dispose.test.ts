/**
 * FileLockService teardown while a critical section is in flight.
 *
 * `cleanup()` runs on every shutdown path — FileLockService.dispose(),
 * StateManager.cleanup() via StateManagerService.dispose(), and the browser/
 * knowledge init locks. None of them are synchronised with an in-flight
 * `withLock` body, so teardown genuinely overlaps a held lock.
 *
 * The old code yanked the lock in that overlap: it unlinked the lock file and
 * nulled the handle. Two things followed. Cross-process exclusion was dropped
 * mid read-modify-write, so a peer could acquire and lose the holder's update.
 * And because `releaseLock()` returns early when the handle is already null —
 * before the `finally` that hands the queue turn on — every caller parked in
 * `acquireLock`'s `await previous` blocked forever. That await has no timeout of
 * its own (lockTimeout only starts once the turn is granted), so it was a
 * permanent wedge, not a slow one.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileLockService } from '../../../src/infrastructure/file-lock-service.ts';

let dir: string;
let lockPath: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-lock-dispose-'));
  lockPath = path.join(dir, 'test.lock');
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
});

function makeLock(overrides: Record<string, unknown> = {}): FileLockService {
  return new FileLockService({
    lockFilePath: lockPath,
    lockTimeout: 2_000,
    lockRetryDelay: 10,
    ...overrides,
  });
}

/** Resolves to 'pending' if the promise has not settled within `ms`. */
function settledWithin<T>(p: Promise<T>, ms: number): Promise<T | 'pending'> {
  return Promise.race([
    p,
    new Promise<'pending'>((r) => setTimeout(() => r('pending'), ms)),
  ]);
}

describe('FileLockService — teardown during a held lock', () => {
  it('waits for an in-flight critical section instead of yanking the lock', async () => {
    const lock = makeLock();
    await lock.initialize();

    let sectionFinished = false;
    let lockFilePresentDuringSection = false;

    const critical = lock.withLock(async () => {
      // dispose() lands here, mid-section.
      await new Promise((r) => setTimeout(r, 300));
      lockFilePresentDuringSection = await fs
        .access(lockPath)
        .then(() => true)
        .catch(() => false);
      sectionFinished = true;
    });

    await new Promise((r) => setTimeout(r, 50));
    await lock.dispose();

    await critical;
    expect(sectionFinished).toBe(true);
    // The whole point: exclusion held for the section's full duration. Without the
    // drain, dispose() unlinked the file here and a peer could have acquired it.
    expect(lockFilePresentDuringSection).toBe(true);
  });

  it('does not strand queued waiters when teardown forces through', async () => {
    // Drain timeout is 5s; hold longer so cleanup is FORCED to tear down under a
    // live holder — the case that previously wedged the queue permanently.
    const lock = makeLock();
    await lock.initialize();

    let releaseHolder!: () => void;
    const holderCanFinish = new Promise<void>((r) => { releaseHolder = r; });
    const holder = lock.withLock(async () => { await holderCanFinish; });

    await new Promise((r) => setTimeout(r, 50));

    // A second caller queues behind the holder, parked on `await previous`.
    const queued = lock.acquireLock();

    await new Promise((r) => setTimeout(r, 50));
    const disposal = lock.cleanup();

    // The queued caller must reach a decision — success or failure — rather than
    // hanging. Before the fix this stayed 'pending' for the process lifetime.
    const outcome = await settledWithin(queued.then(() => 'acquired').catch(() => 'rejected'), 8_000);
    expect(outcome).not.toBe('pending');
    // And it must be refused, not granted: the instance no longer manages the file.
    expect(outcome).toBe('rejected');

    releaseHolder();
    await holder.catch(() => {});
    await disposal;
  }, 20_000);

  it('refuses new acquisitions after disposal rather than blocking on a dead queue', async () => {
    const lock = makeLock();
    await lock.initialize();
    await lock.dispose();

    const outcome = await settledWithin(
      lock.acquireLock().then(() => 'acquired').catch(() => 'rejected'),
      2_000,
    );
    expect(outcome).toBe('rejected');
  });

  it('keeps the ordinary acquire/release cycle working', async () => {
    // Guard against the fix over-reaching: normal FIFO handoff must be untouched.
    const lock = makeLock();
    await lock.initialize();

    const order: number[] = [];
    await Promise.all([
      lock.withLock(async () => { order.push(1); await new Promise((r) => setTimeout(r, 30)); }),
      lock.withLock(async () => { order.push(2); }),
      lock.withLock(async () => { order.push(3); }),
    ]);

    expect(order).toHaveLength(3);
    expect(lock.isLocked()).toBe(false);
    await expect(fs.access(lockPath)).rejects.toThrow(); // released and removed
    await lock.dispose();
  });

  it('a caller mid-acquisition-retry fails fast on cleanup() instead of acquiring on the retired instance', async () => {
    // cleanup()'s drain polls only the HELD handle, and the queued-waiter check
    // runs before the retry loop is entered — so a caller contending for a
    // peer's lock (holding nothing, turn already granted) was invisible to
    // teardown. Pre-fix it survived cleanup(), won the lock when the peer
    // released, and ran its critical section against torn-down services.
    const peer = makeLock();
    await peer.initialize();
    await peer.acquireLock(); // a live owner: genuine contention, no reclaim

    const svc = makeLock();
    await svc.initialize();
    const attempt = svc.acquireLock();
    // Let the caller reach the retry loop (first EEXIST + at least one sleep).
    await new Promise((r) => setTimeout(r, 50));

    await svc.cleanup(); // teardown while the caller is mid-retry

    await expect(attempt).rejects.toThrow(/disposed during acquisition|disposed while queued|has been disposed/);

    // The peer releases; the retired instance must NOT create a lock now.
    await peer.releaseLock();
    await new Promise((r) => setTimeout(r, 100));
    await expect(fs.access(lockPath)).rejects.toThrow(); // nothing re-created it

    await peer.dispose();
  });
});
