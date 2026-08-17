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
    // Tighter than the configured retry budget (24 x 50ms = 1.2s), so "immediately" is
    // what is actually measured. A 2s bound sat comfortably ABOVE that budget and would
    // have passed even if the try-take had exhausted every retry it owns.
    expect(Date.now() - started).toBeLessThan(500);
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

/**
 * A pid is not the only liveness evidence a lock carries.
 *
 * Treating every unidentifiable lock as fully alive was an overcorrection: a file
 * torn by a SIGKILL between open(...,'wx') and write() is unidentifiable by
 * construction, and holding it for the live-owner threshold made knowledge-store
 * init fail where it used to reclaim and proceed. Where a heartbeat runs, a
 * motionless file is evidence of abandonment on its own.
 */
describe('an unidentifiable lock is judged by whether a heartbeat can judge it', () => {
  const call = (svc: any, ageMs: number) => svc._shouldReclaim(null, null, ageMs);

  it('uses a heartbeat-derived window when this lock class heartbeats', async () => {
    const { svc } = await makeLock({ lockStaleThreshold: 15_000, liveOwnerStaleThreshold: 120_000 });
    // Heartbeat is capped at 5s → reclaimable just past the 15s stale threshold, and
    // not at the 120s live-owner threshold. The cap matters: derived from
    // liveOwnerStaleThreshold/4 alone the interval would be 30s and the window 60s,
    // which is longer than the acquirer's own stall bound on every lock class we
    // configure — the reclaim could never happen (see the torn-lock test below).
    await expect(call(svc, 10_000)).resolves.toBe(false);
    await expect(call(svc, 20_000)).resolves.toBe(true);
  });

  it('never reclaims inside one heartbeat interval, so a late tick cannot lose the lock', async () => {
    const { svc } = await makeLock({ lockStaleThreshold: 1_000, liveOwnerStaleThreshold: 120_000 });
    // A tiny stale threshold must not drag the window below the refresh cadence: the
    // floor is two capped heartbeat intervals, not the 1s asked for.
    await expect(call(svc, 8_000)).resolves.toBe(false);
    await expect(call(svc, 11_000)).resolves.toBe(true);
  });

  it('reclaims a torn, ownerless lock instead of timing out short of its own window', async () => {
    // The recovery the unidentified rule exists for: a lock file torn by SIGKILL
    // between open(...,'wx') and write(). It has no pid, so it is judged purely on
    // age — and its mtime never moves again, so it can never show progress and the
    // stall bound is guaranteed to expire first. Both clocks were left to run
    // independently and the shorter one always won, so the reclaim was unreachable
    // on every lock class configured in this repo: knowledge-store init became
    // eligible at 60s and was abandoned at 20s.
    //
    // These numbers are the same shape, scaled down: window 4s, stall bound 500ms.
    const { lockPath } = await makeLock({ lockTimeout: 5_000 });
    await fs.writeFile(lockPath, '', 'utf-8'); // torn: no uuid, no pid, unparseable
    const now = new Date();
    await fs.utimes(lockPath, now, now);

    const peer = await peerOn(lockPath, {
      lockStaleThreshold: 1_000,
      liveOwnerStaleThreshold: 8_000, // heartbeat 2s → unidentified window 4s
      lockTimeout: 500,               // stall bound, far shorter than that window
      acquireCeilingMs: 20_000,
      lockRetryDelay: 25,
    });

    const started = Date.now();
    await expect(peer.acquireLock()).resolves.toBeUndefined();
    const waited = Date.now() - started;
    // Bounded on BOTH sides against the 4s window, not merely "more than the stall
    // bound, less than the ceiling" — that pair admits anything from 0.6s to 14s, so a
    // window collapsed to a few hundred ms or inflated tenfold would both pass.
    expect(waited).toBeGreaterThan(3_500);  // it did NOT give up at the 500ms stall bound
    expect(waited).toBeLessThan(6_000);     // and it did not just wait out the ceiling
    await peer.releaseLock();
  }, 30_000);

  it('the ceiling still ends a wait for a reclaim window that is too far off', async () => {
    // Honouring the reclaim window must not become a licence to ignore the ceiling —
    // a window beyond it is simply unreachable, and the caller has to be told.
    const { lockPath } = await makeLock({ lockTimeout: 5_000 });
    await fs.writeFile(lockPath, '', 'utf-8');
    const now = new Date();
    await fs.utimes(lockPath, now, now);

    const peer = await peerOn(lockPath, {
      lockStaleThreshold: 60_000,      // window 60s
      liveOwnerStaleThreshold: 120_000,
      lockTimeout: 500,
      acquireCeilingMs: 1_500,         // the bound under test
      lockRetryDelay: 25,
    });

    const started = Date.now();
    await expect(peer.acquireLock()).rejects.toThrow(/ceiling 1500ms/);
    expect(Date.now() - started).toBeLessThan(6_000);
  }, 20_000);

  it('a try-take does not wait for a reclaim window, however short', async () => {
    // lockTimeout 0 means "answer now". The run semaphore's slot files are pid-less
    // when torn AND carry the ten-minute no-heartbeat window, so honouring
    // eligibility there would turn a non-blocking probe into a ten-minute block.
    const { lockPath } = await makeLock({ lockTimeout: 5_000 });
    await fs.writeFile(lockPath, JSON.stringify({ uuid: 'no-pid-owner' }), 'utf-8');
    const now = new Date();
    await fs.utimes(lockPath, now, now);

    const peer = await peerOn(lockPath, {
      lockTimeout: 0,
      lockRetries: 24,
      lockRetryDelay: 50,
      lockStaleThreshold: 15_000,
      liveOwnerStaleThreshold: Number.MAX_SAFE_INTEGER,
    });

    const started = Date.now();
    await expect(peer.acquireLock()).rejects.toThrow(/Failed to acquire lock/);
    expect(Date.now() - started).toBeLessThan(3_000);
  }, 20_000);

  it('falls back to the absolute ceiling when no heartbeat runs', async () => {
    // The run semaphore's never-steal opt-out disables the heartbeat entirely, so its
    // slot files never move and age carries no information at all.
    const { svc } = await makeLock({ lockStaleThreshold: 15_000, liveOwnerStaleThreshold: Number.MAX_SAFE_INTEGER });
    await expect(call(svc, 9 * 60_000)).resolves.toBe(false);
    await expect(call(svc, 11 * 60_000)).resolves.toBe(true);
  });
});
