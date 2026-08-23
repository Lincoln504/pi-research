/**
 * A final synthesis that contains no analysis must not ship as a successful report.
 *
 * Twice in the run logs a model returned nothing but a title line. The emptiness guard
 * tested `!result.trim()`, which a 131-character heading passes, and `ensureCitedLinks`
 * then appended the engine's own rebuilt source list below it. What reached the caller
 * was a 6.8KB (and earlier, 9.9KB) document consisting of one heading followed by
 * citations, with not one sentence between them — reported as a completed run. The
 * engine's own citation repair is what made the failure look substantial.
 *
 * Two design properties are under test here, and they are load-bearing together:
 *
 *  1. TWO INDEPENDENT SIGNALS. Volume and sentence structure. Neither is sufficient:
 *     the real 2026-08-23 failure contains "0.5B–6B", whose decimal point defeats the
 *     punctuation check, and is caught on volume alone — while a long title with no
 *     decimals is caught on punctuation at any length.
 *  2. AN ADDITIVE RESPONSE. Tripping the check appends material and never discards
 *     the model's own text, which is what allows the boundary to sit far from real
 *     reports instead of hugging them.
 */

import { describe, it, expect } from 'vitest';
import { synthesisProseBody, isAnalysisFreeSynthesis } from '../../../src/utils/text-utils.ts';
import { MIN_SYNTHESIS_PROSE_CHARS } from '../../../src/constants.ts';

// Verbatim, from the run logs.
const TITLE_ONLY_A =
  'Survey of Small Open-Weight Vision-Language Models (0.5B–6B) Released in 2026 by Independent Labs, Startups, and Emerging AI Groups';
const TITLE_ONLY_B =
  'Road and Path Network Generation Over Uneven Terrain with Non-Tree Topologies: Engineering Constraints, Roundabouts, and Procedural Loop Structures';

// Mirrors the real thing: the block the engine appended in the observed failure was
// 6664 characters across 10+ entries, i.e. 98% of the delivered document.
const CITATION_BLOCK = [
  'CITED LINKS',
  ...Array.from({ length: 12 }, (_, i) =>
    `[${i + 1}] https://example.com/source-${i} [Source: Scrape] — a full-length description of the kind ` +
    'the engine writes when it rebuilds the section, easily several hundred characters on its own.'),
].join('\n');

const REAL_REPORT = 'Findings on the subject, with substantive analysis. '.repeat(22);

const free = (t: string) => isAnalysisFreeSynthesis(t, MIN_SYNTHESIS_PROSE_CHARS);

describe('synthesisProseBody', () => {
  it('returns the whole text when there is no CITED LINKS section', () => {
    expect(synthesisProseBody(TITLE_ONLY_A)).toBe(TITLE_ONLY_A);
  });

  it('excludes the citation block, so a padded report is not mistaken for a full one', () => {
    expect(synthesisProseBody(`${TITLE_ONLY_A}\n\n${CITATION_BLOCK}`)).toBe(TITLE_ONLY_A);
  });

  it('handles the markdown-marker header forms the engine tolerates', () => {
    for (const header of ['CITED LINKS', '## CITED LINKS', '**CITED LINKS', '> CITED LINKS']) {
      expect(synthesisProseBody(`Real analysis here.\n\n${header}\n[1] https://example.com — x`))
        .toBe('Real analysis here.');
    }
  });

  it('does not treat a mid-prose mention as the header', () => {
    const doc = 'See the cited links below for detail on CITED LINKS handling in prose.';
    expect(synthesisProseBody(doc)).toBe(doc);
  });
});

describe('isAnalysisFreeSynthesis — catches both real failures', () => {
  it('flags each title-only synthesis seen in production', () => {
    expect(free(TITLE_ONLY_A)).toBe(true);
    expect(free(TITLE_ONLY_B)).toBe(true);
  });

  it('flags them even once the citation block has padded them to kilobytes', () => {
    const padded = `${TITLE_ONLY_A}\n\n${CITATION_BLOCK}`;
    // Load-bearing: total length alone would have called this a full report.
    expect(padded.length).toBeGreaterThan(MIN_SYNTHESIS_PROSE_CHARS);
    expect(free(padded)).toBe(true);
  });

  it('flags an empty or whitespace-only synthesis', () => {
    expect(free('')).toBe(true);
    expect(free('   \n\n  ')).toBe(true);
  });
});

describe('isAnalysisFreeSynthesis — the two signals cover each other', () => {
  it('catches a SHORT title whose decimal point defeats the punctuation check', () => {
    // The real 2026-08-23 failure: "0.5B–6B" contains a period, so only volume fires.
    expect(/[.!?]/.test(TITLE_ONLY_A)).toBe(true);
    expect(free(TITLE_ONLY_A)).toBe(true);
  });

  it('catches a LONG heading that volume alone would let through', () => {
    // Over the volume floor, but not a single sentence ends anywhere in it.
    const longHeading = 'Comprehensive Survey Of Every Known Approach '.repeat(30);
    expect(longHeading.length).toBeGreaterThan(MIN_SYNTHESIS_PROSE_CHARS);
    expect(/[.!?]/.test(longHeading)).toBe(false);
    expect(free(longHeading)).toBe(true);
  });

  it('is not fooled by markdown decoration around the heading', () => {
    expect(free(`## ${TITLE_ONLY_B}`)).toBe(true);
    expect(free(`**${TITLE_ONLY_B}`)).toBe(true);
    expect(free(`> ${TITLE_ONLY_B}`)).toBe(true);
  });
});

describe('isAnalysisFreeSynthesis — leaves real reports alone', () => {
  it('passes a genuine report, with and without its citation block', () => {
    expect(free(REAL_REPORT)).toBe(false);
    expect(free(`${REAL_REPORT}\n\n${CITATION_BLOCK}`)).toBe(false);
  });

  it('passes the shortest legitimate report observed, with margin', () => {
    // Smallest real prose across the run logs measured 1056–1093 characters.
    expect(MIN_SYNTHESIS_PROSE_CHARS).toBeLessThan(1056);
    expect(free('A'.repeat(1056) + '.')).toBe(false);
  });

  it('sits clear of the observed failures on the other side', () => {
    // 131 and 147 characters of prose.
    expect(MIN_SYNTHESIS_PROSE_CHARS).toBeGreaterThan(147);
  });
});

describe('the volume signal can be disabled where no data justifies a floor', () => {
  it('quick mode (minProseChars = 0) passes a correct one-sentence answer', () => {
    // The whole point: with only a warning available as a response, wrongly flagging a
    // correct short answer is worse than missing a thin one. Quick mode has no measured
    // length distribution, so it relies on structure alone.
    expect(isAnalysisFreeSynthesis('Paris is the capital of France.', 0)).toBe(false);
    expect(isAnalysisFreeSynthesis('Yes — the API supports streaming responses.', 0)).toBe(false);
  });

  it('still flags a bare title at any length with the volume signal off', () => {
    expect(isAnalysisFreeSynthesis(TITLE_ONLY_B, 0)).toBe(true);
    expect(isAnalysisFreeSynthesis('Comprehensive Survey Of Approaches '.repeat(40), 0)).toBe(true);
  });

  it('still flags an empty report with the volume signal off', () => {
    expect(isAnalysisFreeSynthesis('', 0)).toBe(true);
    expect(isAnalysisFreeSynthesis('   \n ', 0)).toBe(true);
  });

  it('deep mode keeps the volume signal, which is what catches a title containing a decimal', () => {
    // TITLE_ONLY_A contains "0.5B–6B", so structure alone misses it — volume is the
    // signal that fires. Neither check is sufficient alone; this pins that.
    expect(isAnalysisFreeSynthesis(TITLE_ONLY_A, 0)).toBe(false);
    expect(isAnalysisFreeSynthesis(TITLE_ONLY_A, MIN_SYNTHESIS_PROSE_CHARS)).toBe(true);
  });
});

describe('the structural signal does not assume Latin punctuation', () => {
  // Quick mode runs this signal ALONE, so a script whose sentences end in something
  // other than a full stop would have every correct answer flagged as thin. Each of
  // these is a complete sentence in its own writing system.
  it.each([
    ['Devanagari danda', 'दिल्ली भारत की राजधानी है।'],
    ['Devanagari double danda', 'यह एक पूर्ण वाक्य है॥'],
    ['Arabic full stop', 'باريس هي عاصمة فرنسا۔'],
    ['Arabic question mark', 'هل هذا صحيح؟'],
    ['Ethiopic full stop', 'አዲስ አበባ የኢትዮጵያ ዋና ከተማ ናት።'],
    ['CJK full stop', '巴黎是法国的首都。'],
    ['fullwidth exclamation', 'これは完全な文です！'],
  ])('passes a complete sentence terminated by a %s', (_label, sentence) => {
    expect(isAnalysisFreeSynthesis(sentence, 0)).toBe(false);
  });

  it('still flags a non-Latin heading that terminates nothing', () => {
    expect(isAnalysisFreeSynthesis('# 大规模语言模型综述', 0)).toBe(true);
    expect(isAnalysisFreeSynthesis('# भारत में नवीकरणीय ऊर्जा', 0)).toBe(true);
  });
});
