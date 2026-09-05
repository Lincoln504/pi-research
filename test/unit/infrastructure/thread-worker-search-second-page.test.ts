/**
 * SCRAPE_SECOND_PAGE — the thread-worker must fetch DuckDuckGo Lite results
 * page 2 for every query when PI_RESEARCH_SCRAPE_SECOND_PAGE=true, merging the
 * second page's results after page 1 (URL-deduped) — and must degrade to
 * page-1-only on any page-2 problem, because page-1 results are already
 * complete and usable.
 *
 * These tests drive executeSearchTask directly with a stubbed page, mirroring
 * the sibling thread-worker-search-uddg-decode tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { executeSearchTask } from '../../../src/infrastructure/browser/thread-worker-messaging.ts';

interface StubLink {
  href: string;
  textContent: string;
}

/**
 * Stub page whose `document` content switches from page-1 links to page-2 links
 * once the next-page control is clicked. `hasNextButton` and `clickFails` let
 * each test shape the degradation paths.
 */
function makeHarness(page1: StubLink[], page2: StubLink[], opts: { hasNextButton?: boolean; clickFails?: boolean } = {}) {
  const { hasNextButton = true, clickFails = false } = opts;
  let onSecondPage = false;
  const makeDom = (links: StubLink[]) => links.map((l) => ({
    href: l.href,
    textContent: l.textContent,
    // Realistic lite DOM: the link's <tr> holds no snippet; the NEXT sibling
    // <tr>'s td.result-snippet does. Inside-row selectors miss, sibling hits.
    closest: () => ({
      querySelector: () => null,
      nextElementSibling: {
        querySelector: (sel: string) => (sel === 'td.result-snippet' ? { textContent: 'snippet text' } : null),
      },
    }),
  }));
  const nextButton = {
    count: vi.fn(async () => (onSecondPage ? 0 : (hasNextButton ? 1 : 0))),
    click: vi.fn(async () => {
      if (clickFails) throw new Error('Target closed');
      onSecondPage = true;
    }),
  };
  const page: any = {
    setDefaultTimeout: () => {},
    setDefaultNavigationTimeout: () => {},
    goto: async () => {},
    locator: (_sel: string) => ({ first: () => nextButton }),
    waitForNavigation: async () => {},
    evaluate: async (fn: () => unknown) => {
      (globalThis as any).document = { querySelectorAll: () => makeDom(onSecondPage ? page2 : page1) };
      try {
        return fn();
      } finally {
        delete (globalThis as any).document;
      }
    },
    close: vi.fn(async () => {}),
  };
  const context = { newPage: async () => page };
  return { context, page, nextButton };
}

describe('executeSearchTask — SCRAPE_SECOND_PAGE', () => {
  beforeEach(() => {
    // Mock-search mode: direct results-URL goto, minimal jitter sleep.
    process.env['PI_RESEARCH_MOCK_SEARCH'] = 'true';
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env['PI_RESEARCH_MOCK_SEARCH'];
    delete process.env['PI_RESEARCH_SCRAPE_SECOND_PAGE'];
  });

  it('merges page-2 results after page 1 when the flag is on and a next control exists', async () => {
    process.env['PI_RESEARCH_SCRAPE_SECOND_PAGE'] = 'true';
    const { context } = makeHarness(
      [{ href: 'https://example.com/p1-a', textContent: 'P1 A' }, { href: 'https://example.com/p1-b', textContent: 'P1 B' }],
      [{ href: 'https://example.com/p2-a', textContent: 'P2 A' }, { href: 'https://example.com/p2-b', textContent: 'P2 B' }],
    );

    const { results } = await executeSearchTask(context, 'two-pages');

    expect(results.map((r: any) => r.url)).toEqual([
      'https://example.com/p1-a',
      'https://example.com/p1-b',
      'https://example.com/p2-a',
      'https://example.com/p2-b',
    ]);
  });

  it('URL-dedups results that appear on both pages, keeping the page-1 copy first', async () => {
    process.env['PI_RESEARCH_SCRAPE_SECOND_PAGE'] = 'true';
    const { context } = makeHarness(
      [{ href: 'https://example.com/shared', textContent: 'Shared' }, { href: 'https://example.com/p1-only', textContent: 'P1 only' }],
      [{ href: 'https://example.com/shared', textContent: 'Shared (dup)' }, { href: 'https://example.com/p2-only', textContent: 'P2 only' }],
    );

    const { results } = await executeSearchTask(context, 'dedup');

    expect(results.map((r: any) => r.url)).toEqual([
      'https://example.com/shared',
      'https://example.com/p1-only',
      'https://example.com/p2-only',
    ]);
  });

  it('returns page 1 alone when no next-page control exists (single page of results)', async () => {
    process.env['PI_RESEARCH_SCRAPE_SECOND_PAGE'] = 'true';
    const { context, nextButton } = makeHarness(
      [{ href: 'https://example.com/p1-a', textContent: 'P1 A' }],
      [{ href: 'https://example.com/p2-a', textContent: 'P2 A' }],
      { hasNextButton: false },
    );

    const { results } = await executeSearchTask(context, 'single-page');

    expect(results).toHaveLength(1);
    expect(results[0].url).toBe('https://example.com/p1-a');
    expect(nextButton.count).toHaveBeenCalled();
  });

  it('never queries the next-page control when the flag is off', async () => {
    const { context, nextButton } = makeHarness(
      [{ href: 'https://example.com/p1-a', textContent: 'P1 A' }],
      [{ href: 'https://example.com/p2-a', textContent: 'P2 A' }],
    );

    const { results } = await executeSearchTask(context, 'flag-off');

    expect(results).toHaveLength(1);
    expect(nextButton.count).not.toHaveBeenCalled();
  });

  it('degrades to page-1 results when the page-2 click fails (no throw, no lost query)', async () => {
    process.env['PI_RESEARCH_SCRAPE_SECOND_PAGE'] = 'true';
    const { context } = makeHarness(
      [{ href: 'https://example.com/p1-a', textContent: 'P1 A' }],
      [{ href: 'https://example.com/p2-a', textContent: 'P2 A' }],
      { clickFails: true },
    );

    const { results } = await executeSearchTask(context, 'click-fails');

    expect(results).toHaveLength(1);
    expect(results[0].url).toBe('https://example.com/p1-a');
  });

  it('does not attempt page 2 when page 1 returned zero results', async () => {
    process.env['PI_RESEARCH_SCRAPE_SECOND_PAGE'] = 'true';
    const { context, nextButton } = makeHarness([], [{ href: 'https://example.com/p2-a', textContent: 'P2 A' }]);

    const { results } = await executeSearchTask(context, 'empty-page1');

    expect(results).toHaveLength(0);
    expect(nextButton.count).not.toHaveBeenCalled();
  });
});
