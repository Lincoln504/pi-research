import { describe, it, expect } from 'vitest';
import { validateContent, isBenignScrapeFailure } from '../../../src/web-research/scraper-utils.ts';

describe('validateContent — stub detection', () => {
  it('does NOT reject a space-less CJK article that is character-rich (regression)', () => {
    // A real Chinese article converts to markdown with almost no whitespace tokens, so the old
    // pure word-count check (words < 50) falsely discarded it as a "stub" — biasing research away
    // from the non-Latin web. It must pass: low word count BUT high non-whitespace char count.
    const cjk = '这是一篇关于人工智能与机器学习的非常详细的技术文章内容'.repeat(10); // ~260 chars, no spaces
    expect(() => validateContent('', cjk, 'https://example.cn/article')).not.toThrow();
  });

  it('still rejects a genuine stub (few words AND few characters)', () => {
    expect(() => validateContent('', 'Access denied. Try again.', 'https://x.com/a')).toThrow(/stub/i);
  });

  it('does not reject substantial Latin content', () => {
    expect(() => validateContent('', 'word '.repeat(60).trim(), 'https://x.com/a')).not.toThrow();
  });
});

describe('isBenignScrapeFailure — expected per-URL scrape outcomes', () => {
  it('treats bot-protection blocks as benign (all BOT_PATTERNS reasons, not just Cloudflare)', () => {
    expect(isBenignScrapeFailure(new Error('Fetch blocked: Cloudflare interstitial'))).toBe(true);
    expect(isBenignScrapeFailure(new Error('Fetch blocked: DDoS-Guard challenge'))).toBe(true);
  });

  it('treats stub pages and HTTP status rejections as benign', () => {
    expect(isBenignScrapeFailure(new Error('Fetch returned stub: only 3 words / 12 chars found.'))).toBe(true);
    expect(isBenignScrapeFailure(new Error('HTTP 403'))).toBe(true);
    expect(isBenignScrapeFailure(new Error('HTTP 503'))).toBe(true);
  });

  it('treats remote timeouts and pool-drain/teardown races as benign', () => {
    expect(isBenignScrapeFailure(new Error('Scrape task timed out after 30000ms'))).toBe(true);
    expect(isBenignScrapeFailure(new Error('Cannot execute a task on destroying pool'))).toBe(true);
  });

  it('does NOT treat genuine engine faults as benign', () => {
    expect(isBenignScrapeFailure(new Error('Browser markdown conversion failed: TypeError'))).toBe(false);
    expect(isBenignScrapeFailure(new Error('Network failure'))).toBe(false);
    // A non-2xx-looking string that is not an HTTP status line stays non-benign.
    expect(isBenignScrapeFailure(new Error('HTTPClient exploded'))).toBe(false);
  });

  it('treats a PDF that exceeds the 100MB size cap as benign, same as a malformed one', () => {
    // extractPdfToMarkdown's own size guard and the fetch layer's streamed-cap
    // guard both throw messages starting with 'PDF too large' — this was
    // missing from the benign set, so a PDF that was simply too large (a
    // routine, non-actionable outcome, same category as a malformed/
    // encrypted PDF) got logged as a genuine ERROR and inflated the
    // diagnostic error-tracker count.
    expect(isBenignScrapeFailure(new Error('PDF too large (150MB, max 100MB)'))).toBe(true);
    expect(isBenignScrapeFailure(new Error('PDF too large (streamed 120MB, max 100MB)'))).toBe(true);
  });

  it('does NOT treat a pdf-oxide-wasm native-module load failure as benign', () => {
    // Unlike a per-PDF parse failure, a failed native-module load means PDF
    // extraction is broken for every URL, not just this one — an
    // infrastructure fault that must still surface at ERROR, not be silently
    // swept into the same "routine per-PDF outcome" bucket.
    expect(isBenignScrapeFailure(new Error('PDF extraction unavailable (pdf-oxide-wasm failed to load: Cannot find module)'))).toBe(false);
  });

  it('handles non-Error inputs without throwing', () => {
    expect(isBenignScrapeFailure('Fetch blocked: Cloudflare challenge')).toBe(true);
    expect(isBenignScrapeFailure(undefined)).toBe(false);
    expect(isBenignScrapeFailure(null)).toBe(false);
  });
});
