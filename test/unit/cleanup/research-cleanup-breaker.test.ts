/**
 * Research-cleanup — session circuit-breaker clearing (FIX #10 key mismatch).
 *
 * Breakers are keyed by researchId (`${piSessionId}-<8 hex>`, threaded by
 * tools/scrape.ts as BrowserTask.sessionId), but createCleanupFunction only
 * knows the parent piSessionId and called clearSessionCircuitBreaker with it —
 * a no-op, so every research run leaked its breaker (state included: a breaker
 * OPEN from a bad run stayed open for any future run that reused the key).
 * The cleanup must sweep all breakers under the `${piSessionId}-` prefix.
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
  clearSessionCircuitBreakersByPrefix,
  resetBrowserCircuitBreaker,
} from '../../../src/infrastructure/browser/browser-error-utils.ts';

afterEach(() => {
  resetBrowserCircuitBreaker();
});

describe('clearSessionCircuitBreakersByPrefix', () => {
  it('clears every breaker under the prefix and leaves other sessions untouched', () => {
    const a1 = getBrowserCircuitBreaker('sessA-11111111');
    const a2 = getBrowserCircuitBreaker('sessA-22222222');
    const b1 = getBrowserCircuitBreaker('sessB-33333333');

    clearSessionCircuitBreakersByPrefix('sessA-');

    // Cleared keys yield FRESH breaker instances; the untouched one is retained.
    expect(getBrowserCircuitBreaker('sessA-11111111')).not.toBe(a1);
    expect(getBrowserCircuitBreaker('sessA-22222222')).not.toBe(a2);
    expect(getBrowserCircuitBreaker('sessB-33333333')).toBe(b1);
  });
});

describe('createCleanupFunction — breaker key mismatch', () => {
  it('clears a breaker keyed by researchId even though cleanup only holds the piSessionId', async () => {
    const piSessionId = 'pisess-w7';
    const researchId = `${piSessionId}-a1b2c3d4`; // how shared-links generateSessionId builds it
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

    // Pre-fix: clearSessionCircuitBreaker(piSessionId) was a no-op for this key,
    // so the SAME stale instance came back.
    expect(getBrowserCircuitBreaker(researchId)).not.toBe(stale);
  });
});
