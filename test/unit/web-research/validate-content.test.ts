import { describe, it, expect } from 'vitest';
import { validateContent } from '../../../src/web-research/scraper-utils.ts';

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
