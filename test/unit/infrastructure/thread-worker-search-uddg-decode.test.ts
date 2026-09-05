/**
 * Regression: DDG Lite redirect-target extraction must decode `uddg` exactly ONCE.
 *
 * `URLSearchParams.get()` already percent-decodes the parameter value. The old
 * code ran decodeURIComponent over that result a second time, which:
 *   (a) structurally corrupted any target whose CANONICAL form itself contains
 *       escapes — `?x=1%26y%3D2` (one parameter whose value embeds `&`/`=`)
 *       became `?x=1&y=2` (two parameters), so the later scrape fetched the
 *       wrong resource; and
 *   (b) threw URIError on a once-decoded target containing a lone `%` (e.g.
 *       `/50%-off`), which the surrounding catch swallowed — leaving `url` as
 *       the duckduckgo.com redirect href that the hostname filter then dropped,
 *       silently losing the result.
 * These tests pin the once-decoded contract through executeSearchTask, driving
 * extractSearchResults' page.evaluate callback against a stubbed DOM.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { executeSearchTask } from '../../../src/infrastructure/browser/thread-worker-messaging.ts';

interface StubLink {
  href: string;
  textContent: string;
}

/**
 * Minimal page whose evaluate() runs the extraction callback in-process against
 * a stubbed `document` exposing the anchors extractSearchResults queries for.
 * Mirrors the mock-page shape of the sibling thread-worker tests.
 */
function makeHarness(links: StubLink[]) {
  const domLinks = links.map((l) => ({
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
  const page: any = {
    setDefaultTimeout: () => {},
    setDefaultNavigationTimeout: () => {},
    goto: async () => {},
    evaluate: async (fn: () => unknown) => {
      (globalThis as any).document = { querySelectorAll: () => domLinks };
      try {
        return fn();
      } finally {
        delete (globalThis as any).document;
      }
    },
    close: vi.fn(async () => {}),
  };
  const context = { newPage: async () => page };
  return { context, page };
}

describe('executeSearchTask — uddg redirect target is decoded exactly once', () => {
  beforeEach(() => {
    // Mock-search mode: direct results-URL goto, minimal jitter sleep.
    process.env['PI_RESEARCH_MOCK_SEARCH'] = 'true';
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env['PI_RESEARCH_MOCK_SEARCH'];
  });

  it('keeps canonical escapes intact — %2526/%253D in the raw param stays %26/%3D, never a second decode', async () => {
    // searchParams.get('uddg') yields https://example.com/path/a/b?x=1%26y%3D2 —
    // ONE query parameter `x` whose value embeds & and =. A second decode turned
    // it into ?x=1&y=2 (TWO parameters), a structurally different URL.
    const { context } = makeHarness([
      {
        href: 'https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpath%2Fa%2Fb%3Fx%3D1%2526y%253D2',
        textContent: 'Escaped-target result',
      },
    ]);

    const { results } = await executeSearchTask(context, 'once-decode');

    expect(results).toHaveLength(1);
    expect(results[0].url).toBe('https://example.com/path/a/b?x=1%26y%3D2');
    expect(results[0].title).toBe('Escaped-target result');
  });

  it('survives a target whose once-decoded form contains a lone % (double-decode threw URIError and dropped it)', async () => {
    // Once-decoded target: https://example.com/50%-off — decodeURIComponent on
    // it throws URIError. Pre-fix the catch left `url` as the duckduckgo.com
    // href, and the hostname filter then silently dropped the result.
    const { context } = makeHarness([
      {
        href: 'https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2F50%25-off',
        textContent: 'Lone-percent result',
      },
    ]);

    const { results } = await executeSearchTask(context, 'lone-percent');

    expect(results).toHaveLength(1);
    expect(results[0].url).toBe('https://example.com/50%-off');
  });

  it('passes a plain non-redirect result URL through unchanged', async () => {
    const { context } = makeHarness([
      {
        href: 'https://example.com/plain/page?q=hello%20world',
        textContent: 'Plain result',
      },
    ]);

    const { results } = await executeSearchTask(context, 'plain');

    expect(results).toHaveLength(1);
    expect(results[0].url).toBe('https://example.com/plain/page?q=hello%20world');
  });
});
