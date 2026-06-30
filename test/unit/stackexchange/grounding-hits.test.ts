/**
 * stackexchange — details.groundingHits wiring (researcher-executor grounding gate)
 *
 * Drives the REAL stackexchangeCommand() with a mocked REST client to prove that the grounding
 * signal it reports (details.groundingHits) equals the number of real items returned: the array
 * length for a `search`, 1 for a single get/user/site object, and 0 when nothing is found. The
 * executor's grounding gate reads exactly this field, so a regression here would wrongly fail
 * stackexchange-grounded deep researchers as "ungrounded".
 *
 * Kept out of test/unit/tools/stackexchange.test.ts, which mocks stackexchangeCommand away.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRequest } = vi.hoisted(() => ({ mockRequest: vi.fn() }));

// Replace the REST client so `new StackExchangeClient(...)` inside stackexchangeCommand returns
// a stub whose request() we control; quota is healthy so the command runs the real command path.
vi.mock('../../../src/stackexchange/rest-client.ts', () => ({
  StackExchangeClient: class {
    isQuotaExhausted() { return false; }
    isQuotaLow() { return false; }
    getQuotaInfo() { return { remaining: 100, max: 300, requestCount: 1, lastBackoff: null }; }
    request(...args: unknown[]) { return mockRequest(...args); }
  },
}));

import { stackexchangeCommand } from '../../../src/stackexchange/index.ts';

const ctx = { ui: { notify: vi.fn() } } as any;

describe('stackexchange details.groundingHits', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('search → groundingHits equals the number of questions returned', async () => {
    // executeSearch paginates: first page returns items, the next empty page stops the loop.
    mockRequest
      .mockResolvedValueOnce({ items: [{ question_id: 1 }, { question_id: 2 }, { question_id: 3 }], has_more: false })
      .mockResolvedValue({ items: [], has_more: false });

    const res = await stackexchangeCommand({ command: 'search', params: { query: 'rust async', format: 'json' }, ctx });
    expect((res.details as { groundingHits?: number }).groundingHits).toBe(3);
  });

  it('search with no results → groundingHits is 0 (correctly NOT grounding)', async () => {
    mockRequest.mockResolvedValue({ items: [], has_more: false });

    const res = await stackexchangeCommand({ command: 'search', params: { query: 'no-such-topic', format: 'json' }, ctx });
    expect((res.details as { groundingHits?: number }).groundingHits).toBe(0);
  });

  it('get (a single populated object) → groundingHits is 1', async () => {
    // executeGet issues two requests: the question, then its answers.
    mockRequest
      .mockResolvedValueOnce({ items: [{ question_id: 42, title: 'q', body: '...' }], has_more: false })
      .mockResolvedValueOnce({ items: [{ answer_id: 7, body: 'ans' }], has_more: false });

    const res = await stackexchangeCommand({ command: 'get', params: { id: '42', format: 'json' }, ctx });
    expect((res.details as { groundingHits?: number }).groundingHits).toBe(1);
  });
});
