/**
 * research-session-service Unit Tests
 *
 * Focuses on the teardown contract: abortAllSessions/cleanup gate the
 * fast-stop throw and run()'s finally, so a wedged session.abort() (which
 * awaits the very in-flight call it cancels and may never settle) must never
 * hang them — each abort is bounded, then the registry is cleared anyway.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ResearchSessionService } from '../../../src/orchestration/research-session-service.ts';

vi.mock('../../../src/logger.ts', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));

const STUB_SESSION = {} as any;

describe('ResearchSessionService', () => {
  let service: ResearchSessionService;

  beforeEach(() => {
    service = new ResearchSessionService();
  });

  describe('abortAllSessions', () => {
    it('aborts and clears every registered session for the id', async () => {
      const abortA = vi.fn(async () => {});
      const abortB = vi.fn(async () => {});
      service.registerSession('r1', 'a', STUB_SESSION, abortA);
      service.registerSession('r1', 'b', STUB_SESSION, abortB);

      await service.abortAllSessions('r1');

      expect(abortA).toHaveBeenCalledOnce();
      expect(abortB).toHaveBeenCalledOnce();
      expect(service.getActiveSessionCount('r1')).toBe(0);
    });

    it('swallows an abort rejection and still clears the registry', async () => {
      service.registerSession('r1', 'a', STUB_SESSION, vi.fn(async () => { throw new Error('abort failed'); }));

      await expect(service.abortAllSessions('r1')).resolves.toBeUndefined();
      expect(service.getActiveSessionCount('r1')).toBe(0);
    });

    it('settles within the bound when a session abort never settles (wedged in-flight call)', async () => {
      vi.useFakeTimers();
      try {
        const wedged = vi.fn(() => new Promise<void>(() => { /* never settles */ }));
        const healthy = vi.fn(async () => {});
        service.registerSession('r1', 'wedged', STUB_SESSION, wedged);
        service.registerSession('r1', 'healthy', STUB_SESSION, healthy);

        const teardown = service.abortAllSessions('r1');
        // Fire the 10s abort-settle bound.
        await vi.advanceTimersByTimeAsync(10_001);

        await expect(teardown).resolves.toBeUndefined();
        expect(wedged).toHaveBeenCalledOnce();
        expect(healthy).toHaveBeenCalledOnce();
        expect(service.getActiveSessionCount('r1')).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not erase — or orphan live — a session registered DURING the bounded abort awaits', async () => {
      // Regression: the per-sessionId branch snapshotted the entries, awaited the
      // bounded aborts, then blanket-clear()ed the map — erasing (without
      // aborting) any session registered while the awaits were in flight, e.g. a
      // researcher retry building a fresh session. Only the snapshotted entries
      // may be removed.
      const lateAbort = vi.fn(async () => {});
      const firstAbort = vi.fn(async () => {
        service.registerSession('r1', 'late', STUB_SESSION, lateAbort);
      });
      service.registerSession('r1', 'first', STUB_SESSION, firstAbort);

      await service.abortAllSessions('r1');

      expect(firstAbort).toHaveBeenCalledOnce();
      // The late session was never aborted here, so it must still be registered
      // (its owner's cleanup path remains responsible for it).
      expect(lateAbort).not.toHaveBeenCalled();
      expect(service.hasSession('r1', 'late')).toBe(true);
      expect(service.hasSession('r1', 'first')).toBe(false);
    });

    it('a session re-registered under the same id during the aborts survives (identity check)', async () => {
      const replacementEntry = { fresh: true } as any;
      const replacementAbort = vi.fn(async () => {});
      const firstAbort = vi.fn(async () => {
        service.registerSession('r1', 'a', replacementEntry, replacementAbort);
      });
      service.registerSession('r1', 'a', STUB_SESSION, firstAbort);

      await service.abortAllSessions('r1');

      expect(replacementAbort).not.toHaveBeenCalled();
      expect(service.getSession('r1', 'a')?.session).toBe(replacementEntry);
    });

    it('does not resurrect an empty bucket for an unknown id (read path uses peek)', async () => {
      await service.abortAllSessions('completed-run');
      // Create-on-write on this read path would leak one empty map per completed
      // researchId for the lifetime of the host process.
      expect((service as any).sessions.has('completed-run')).toBe(false);
    });

    it('cleanup() (run() finally path) is bounded the same way for the all-sessions branch', async () => {
      vi.useFakeTimers();
      try {
        service.registerSession('r1', 'wedged', STUB_SESSION, vi.fn(() => new Promise<void>(() => {})));

        // No sessionId — exercises the all-sessions branch used by dispose().
        const teardown = service.cleanup();
        await vi.advanceTimersByTimeAsync(10_001);

        await expect(teardown).resolves.toBeUndefined();
        expect(service.getActiveSessionCount('r1')).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
