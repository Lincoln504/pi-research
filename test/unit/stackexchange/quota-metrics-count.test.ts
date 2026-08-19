/**
 * Regression: getQuotaInfo() used to increment stackexchange_quota_low_total /
 * stackexchange_quota_exhausted_total as a side effect of what looks like — and is
 * called like — a plain accessor. stackexchangeCommand() calls client.getQuotaInfo()
 * up to three times in a single invocation (pre-request gate check, success-path
 * footer, error-path footer), so one real "quota low"/"quota exhausted" observation
 * was recorded 2-3x — the same double-counting failure mode already fixed for
 * tool_security_search_calls_total (see test/unit/tools/security.test.ts).
 *
 * The fix increments each counter exactly once, at the single gate check
 * (isQuotaLow()/isQuotaExhausted()) that actually observes the event; getQuotaInfo()
 * is now a pure accessor with no metrics side effects.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { metrics } from '../../../src/utils/metrics.ts';
import { sumCounter } from '../../../src/utils/metrics-summary.ts';

const { mockRequest } = vi.hoisted(() => ({ mockRequest: vi.fn() }));

vi.mock('../../../src/stackexchange/rest-client.ts', () => ({
  StackExchangeClient: class {
    isQuotaExhausted() { return false; }
    isQuotaLow() { return true; }
    getQuotaInfo() { return { remaining: 5, max: 300, requestCount: 295, lastBackoff: null }; }
    request(...args: unknown[]) { return mockRequest(...args); }
  },
}));

import { stackexchangeCommand } from '../../../src/stackexchange/index.ts';

const ctx = { ui: { notify: vi.fn() } } as any;

describe('stackexchange quota metrics — counted once per real event, not per read', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    metrics.clearSession();
  });

  it('records stackexchange_quota_low_total exactly ONCE per call, even though getQuotaInfo() is read 3x', async () => {
    mockRequest.mockResolvedValue({ items: [], has_more: false });

    await stackexchangeCommand({ command: 'search', params: { query: 'rust async', format: 'json' }, ctx });

    const counters = metrics.getSessionSnapshot().counters;
    expect(sumCounter(counters, 'stackexchange_quota_low_total')).toBe(1);
  });
});
