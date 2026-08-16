/**
 * Waiting for a lock is bounded by the holder's STALL, not by the clock.
 *
 * `lockTimeout` used to bound total elapsed wait, which made ordinary contention
 * indistinguishable from a deadlock and turned it into failed runs. The
 * knowledge-store init lock allows 20s, while that same lock covers a post-run FTS
 * rebuild plus optimize — unbounded housekeeping. A second research run starting
 * during another's housekeeping therefore failed outright rather than waiting its
 * turn: twice on 2026-08-14, at 23:48:08 and 23:49:09, both reported to the user
 * as run errors.
 *
 * Widening the constant is the fix that does not work, because housekeeping has no
 * fixed duration. Instead the wait now watches for evidence that the lock is
 * moving — its holder's heartbeat refreshing the mtime, or the lock changing hands
 * — and gives up only when nothing has moved for `lockTimeout`. An absolute
 * ceiling keeps "wait while progress happens" from meaning "wait forever".
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { FileLockService } from '../../../src/infrastructure/file-lock-service.ts';

const services: FileLockService[] = [];

async function makeLock(opts: Record<string, unknown>): Promise<{ svc: FileLockService; lockPath: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flpaw-'));
  const lockPath = path.join(dir, 'a.lock');
  const svc = new FileLockService({ lockFilePath: lockPath, ...opts } as any);
  await svc.initialize();
  services.push(svc);
  return { svc, lockPath };
}

async function peerOn(lockPath: string, opts: Record<string, unknown>): Promise<FileLockService> {
  const svc = new FileLockService({ lockFilePath: lockPath, ...opts } as any);
  await svc.initialize();
  services.push(svc);
  return svc;
}

afterEach(async () => {
  while (services.length) await services.pop()!.dispose().catch(() => {});
});

describe('lock acquisition waits on progress, not on the clock', () => {
  it('waits out a holder that is working, well past lockTimeout', async () => {
    // Holder heartbeats every 2s (the floor). The peer allows a 3.5s stall — under
    // the old rule it failed 3.5s in; now each heartbeat resets that clock, so it
    // waits the full ~7s hold and then wins.
    const { svc: holder, lockPath } = await makeLock({
      liveOwnerStaleThreshold: 8_000, // heartbeat interval = max(2s, 2s) = 2s
      lockTimeout: 1_000,
    });
    await holder.acquireLock();

    const peer = await peerOn(lockPath, {
      liveOwnerStaleThreshold: 8_000,
      lockTimeout: 3_500,
      lockRetryDelay: 50,
    });

    const releaseAt = Date.now() + 7_000;
    const release = (async () => {
      await new Promise(r => setTimeout(r, 7_000));
      await holder.releaseLock();
    })();

    const started = Date.now();
    await expect(peer.acquireLock()).resolves.toBeUndefined();
    const waited = Date.now() - started;
    await release;

    expect(waited).toBeGreaterThan(3_500); // would have failed here before
    expect(Date.now()).toBeGreaterThanOrEqual(releaseAt - 500);
    await peer.releaseLock();
  }, 30_000);

  it('still gives up on a lock that nobody is touching', async () => {
    // No holder process, no heartbeat: a hand-written lock file that never moves.
    // The stall budget must still expire, or a wedged holder blocks forever.
    const { lockPath } = await makeLock({ lockTimeout: 500 });
    await fs.writeFile(lockPath, JSON.stringify({ uuid: 'someone-else', pid: process.pid }), 'utf-8');
    const aged = new Date(Date.now() - 5_000);
    await fs.utimes(lockPath, aged, aged);

    const peer = await peerOn(lockPath, {
      lockTimeout: 500,
      lockRetryDelay: 25,
      liveOwnerStaleThreshold: 600_000, // never reclaimable, so only the stall bound can end this
    });

    const started = Date.now();
    await expect(peer.acquireLock()).rejects.toThrow(/no sign of progress from its holder/);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 20_000);

  it('a try-take still fails immediately rather than waiting for progress', async () => {
    // research-run-semaphore uses lockTimeout 0 to probe a slot without blocking.
    // Progress-aware waiting must not turn that into a wait.
    const { svc: holder, lockPath } = await makeLock({ lockTimeout: 5_000 });
    await holder.acquireLock();

    const peer = await peerOn(lockPath, { lockTimeout: 0, lockRetries: 24, lockRetryDelay: 50 });

    const started = Date.now();
    await expect(peer.acquireLock()).rejects.toThrow(/Failed to acquire lock/);
    expect(Date.now() - started).toBeLessThan(2_000);
    await holder.releaseLock();
  }, 20_000);

  it('a try-take still has the iterations to reclaim a dead owner and take the slot', async () => {
    // The try-take keeps its CONFIGURED retry count rather than the enlarged budget
    // the waiting path gets, because its reclaim branch loops without ever reaching
    // a time check — that count is its only bound. It must still be enough to do
    // what research-run-semaphore sized it for: reclaim a dead owner's slot and
    // acquire it, in one non-blocking attempt.
    const { lockPath } = await makeLock({ lockTimeout: 5_000 });
    // A dead owner: pid 1 with a start time that cannot match it.
    await fs.writeFile(lockPath, JSON.stringify({ uuid: 'dead-owner', pid: 2 ** 30, startTime: 1 }), 'utf-8');

    const peer = await peerOn(lockPath, { lockTimeout: 0, lockRetries: 24, lockRetryDelay: 50 });

    await expect(peer.acquireLock()).resolves.toBeUndefined();
    await peer.releaseLock();
  }, 20_000);

  it('the ceiling ends a wait behind a holder that never finishes', async () => {
    // Progress alone must not be a licence to wait forever — a holder that keeps
    // heartbeating but never releases has to be given up on eventually.
    const { svc: holder, lockPath } = await makeLock({
      liveOwnerStaleThreshold: 8_000,
      lockTimeout: 5_000,
    });
    await holder.acquireLock();

    const peer = await peerOn(lockPath, {
      liveOwnerStaleThreshold: 8_000,
      lockTimeout: 60_000,     // stall budget far beyond the ceiling
      acquireCeilingMs: 1_500, // the bound under test
      lockRetryDelay: 25,
    });

    const started = Date.now();
    await expect(peer.acquireLock()).rejects.toThrow(/ceiling 1500ms/);
    expect(Date.now() - started).toBeLessThan(6_000);
    await holder.releaseLock();
  }, 20_000);
});
