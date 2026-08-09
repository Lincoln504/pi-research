/**
 * stackexchange — command=get with format=compact.
 *
 * formatCompact() only branched on Array.isArray(result) — dispatching to the
 * per-entity compact formatters for search/user/site results. executeGet()
 * returns a DIFFERENT shape, `{question, answers}` (a single question plus
 * its answers, not an array), which fell through every branch and hit the
 * raw `JSON.stringify(result)` fallback: format=compact silently produced an
 * uncurated JSON dump for this command, unlike formatTable's equivalent
 * `'question' in result && 'answers' in result` branch.
 *
 * Mirrors grounding-hits.test.ts's harness: mocks the REST client (not
 * fetch) so stackexchangeCommand's real command + formatting path runs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRequest } = vi.hoisted(() => ({ mockRequest: vi.fn() }));

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

describe('stackexchange — command=get, format=compact', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('renders a curated compact question+answers summary, not a raw JSON dump', async () => {
    mockRequest
      .mockResolvedValueOnce({
        items: [{
          question_id: 42,
          title: 'How does async work in Rust?',
          link: 'https://stackoverflow.com/q/42',
          score: 17,
          answer_count: 1,
          view_count: 900,
          accepted_answer_id: 7,
          body: 'question body...',
        }],
        has_more: false,
      })
      .mockResolvedValueOnce({
        items: [{
          answer_id: 7,
          score: 23,
          is_accepted: true,
          owner: { display_name: 'Ferris' },
          body: 'answer body...',
        }],
        has_more: false,
      });

    const res = await stackexchangeCommand({ command: 'get', params: { id: '42', format: 'compact' }, ctx });
    const text = (res.content[0] as any).text as string;

    // Not the raw JSON.stringify fallback — a literal object-key dump.
    expect(text).not.toContain('"question_id"');
    expect(text).not.toContain('"answer_id"');
    // The curated formatters' actual output.
    expect(text).toContain('[How does async work in Rust?](https://stackoverflow.com/q/42)');
    expect(text).toContain('by Ferris');
  });
});
