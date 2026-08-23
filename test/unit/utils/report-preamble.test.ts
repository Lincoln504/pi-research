/**
 * A report that opens by narrating itself.
 *
 * Observed repeatedly in live quick runs: the delivered document's first line was
 * "I have gathered extensive material from the Chrome developer blogs, the W3C spec,
 * and other sources. Let me now synthesize my findings into a comprehensive report on
 * what changed in the WebGPU specification during 2026." — followed by a blank line and
 * the actual report. The researcher prompt forbids this and the instruction is not
 * reliably obeyed, so quick mode removes the line before delivering the report.
 *
 * Removing a line is DESTRUCTIVE, so every condition below is a required narrowing
 * rather than a heuristic score. These tests pin both halves: the two openers actually
 * seen in production are removed, and every shape that could plausibly be a real report
 * is left alone.
 */

import { describe, it, expect } from 'vitest';
import { stripReportPreamble } from '../../../src/utils/text-utils.ts';

const BODY =
  '# What Changed in the WebGPU Specification During 2026\n\n' +
  'The specification advanced from Working Draft to Candidate Recommendation during 2026, ' +
  'with the CRD published on 20 August [1]. All major browsers shipped stable support in ' +
  'the same period, and the working group expects to demonstrate interoperability before ' +
  'advancing further [2].';

describe('stripReportPreamble — removes the openers seen in production', () => {
  it.each([
    'I have gathered extensive material from the Chrome developer blogs, the W3C spec, and other sources. Let me now synthesize my findings into a comprehensive report on what changed in the WebGPU specification during 2026.',
    'I have gathered sufficient material from multiple authoritative sources. I will now synthesize the full report.',
  ])('drops %s', (opener) => {
    const { body, preamble } = stripReportPreamble(`${opener}\n\n${BODY}`);
    expect(preamble).toBe(opener);
    expect(body).toBe(BODY);
  });

  it('tolerates leading whitespace before the narration', () => {
    const { preamble } = stripReportPreamble(`\n\n  I will now synthesize the full report.\n\n${BODY}`);
    expect(preamble).toBe('I will now synthesize the full report.');
  });
});

describe('stripReportPreamble — leaves anything that could be a report alone', () => {
  it('keeps a report that opens correctly, with a title', () => {
    const input = `${BODY}`;
    expect(stripReportPreamble(input)).toEqual({ body: input, preamble: '' });
  });

  it('keeps a first-person line that is not about reporting', () => {
    // First person alone is not enough: the line has to be ABOUT the act of reporting.
    const input = `I2C bus contention was the root cause identified by the vendor.\n\n${BODY}`;
    expect(stripReportPreamble(input).preamble).toBe('');
  });

  it('keeps a line about reporting that is not first-person', () => {
    const input = `Reports of the outage first surfaced on 12 March.\n\n${BODY}`;
    expect(stripReportPreamble(input).preamble).toBe('');
  });

  it('keeps a multi-line opening block, which is a paragraph and not an aside', () => {
    const input = `I have gathered the sources.\nThey cover the whole period in question.\n\n${BODY}`;
    expect(stripReportPreamble(input).preamble).toBe('');
  });

  it('strips down to a SHORT answer rather than padding it with the narration', () => {
    // There is no length floor on the remainder. A one-line answer is the answer, and
    // keeping the narration in front of it would both deliver the wrong text and lend
    // its full stop to the analysis check that runs on the result afterwards.
    const input = 'I will now synthesize the full report.\n\nWebGPU reached CRD on 20 August 2026.';
    expect(stripReportPreamble(input)).toEqual({
      body: 'WebGPU reached CRD on 20 August 2026.',
      preamble: 'I will now synthesize the full report.',
    });
  });

  it('keeps the text when the narration is all there is', () => {
    const input = 'I will now synthesize the full report.\n\n   \n';
    expect(stripReportPreamble(input).preamble).toBe('');
  });

  it('keeps text with no blank line at all — there is no separated preamble to remove', () => {
    const input = `I will now synthesize the full report. ${BODY.replace(/\n\n/g, ' ')}`;
    expect(stripReportPreamble(input).preamble).toBe('');
  });

  it('is a no-op on an empty report', () => {
    expect(stripReportPreamble('')).toEqual({ body: '', preamble: '' });
  });
});
