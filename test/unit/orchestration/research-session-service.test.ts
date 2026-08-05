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
