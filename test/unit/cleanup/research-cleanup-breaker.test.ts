/**
 * Research-cleanup — session circuit-breaker clearing (FIX #10 key format).
 *
 * Breakers are keyed by the plain researchId — createResearchRunId() produces it
 * (`run-<8 hex>`) independently of piSessionId, and tools/scrape.ts / tools/search.ts
 * thread that same bare researchId into getBrowserCircuitBreaker() as
 * BrowserTask.sessionId. createCleanupFunction previously assumed a
 * `${piSessionId}-<8 hex>` key shape (the shape generateSessionId() would produce,
 * but that function has no production caller) and cleared by that prefix / the bare
 * piSessionId — both no-ops against the real key, so every research run leaked its
 * breaker (state included: a breaker OPEN from a bad run stayed open for any future
 * run that reused the key) on any path where research-cleanup.ts's own cleanup runs
 * without research-orchestration-service.ts's cleanupResearchServices() also having
 * run (e.g. a throw before orchestrator.run() is ever reached). The fix clears by
 * the exact researchId.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../../src/orchestration/session-state.ts', () => ({
  endResearchSession: vi.fn(),
  getPiActivePanels: vi.fn(() => []),
  refreshAllSessions: vi.fn(),
}));

vi.mock('../../../src/utils/shared-links.ts', () => ({
  cleanupSharedLinks: vi.fn(),
}));

vi.mock('../../../src/logger.ts', () => ({
  logger: { log: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  resetLogger: vi.fn(),
  getLogger: vi.fn(),
}));

import { createCleanupFunction } from '../../../src/cleanup/research-cleanup.ts';
import {
  getBrowserCircuitBreaker,
  resetBrowserCircuitBreaker,
} from '../../../src/infrastructure/browser/browser-error-utils.ts';

afterEach(() => {
  resetBrowserCircuitBreaker();
});

describe('createCleanupFunction — breaker key format', () => {
  it('clears the breaker keyed by the real researchId format, generated independently of piSessionId', async () => {
    // Matches production: createResearchRunId() in log-utils.ts produces `run-<8 hex>`
    // with no relation to piSessionId, and that bare researchId is exactly what
    // tools/scrape.ts / tools/search.ts pass to getBrowserCircuitBreaker() as
    // BrowserTask.sessionId.
    const piSessionId = 'pisess-w7';
    const researchId = 'run-a1b2c3d4';
    const stale = getBrowserCircuitBreaker(researchId);

    const cleanup = createCleanupFunction(
      {
        researchId,
        piSessionId,
        masterWidgetId: 'w',
        panelState: {} as any,
        waveTimer: null,
        unsubOrder: null,
      },
      { ctx: {} as any },
    );
    await cleanup();

    // Pre-fix: the code cleared by the `${piSessionId}-` prefix / bare piSessionId,
    // neither of which matches `run-a1b2c3d4` — the SAME stale instance came back.
    expect(getBrowserCircuitBreaker(researchId)).not.toBe(stale);
  });
});
