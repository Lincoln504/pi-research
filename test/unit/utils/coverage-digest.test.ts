/**
 * Coverage digest splitting.
 *
 * This runs on every researcher report before it is stored, which makes it the one place
 * in the system that can silently DESTROY a run's product: a split that eats the body
 * leaves the synthesizer with nothing to write from, and nothing errors. Every test below
 * that asserts "no digest" is really asserting "the report survived intact".
 */

import { describe, it, expect } from 'vitest';
import {
  splitCoverageDigest,
  deriveCoverageDigest,
  formatDigestsForRouter,
  MAX_DIGEST_CHARS,
} from '../../../src/utils/coverage-digest.ts';

const DIGEST = [
  'COVERAGE DIGEST',
  'Goal: establish the release timeline',
  'Covered: v4.2 ship date; the deprecation of the legacy API',
  'Unsubstantiated: the claimed 40% speedup',
  'Gaps: pricing changes after the release',
  'Sources: 5',
  'END COVERAGE DIGEST',
].join('\n');

const BODY = 'Release timeline\n\nThe v4.2 release shipped on 3 March [1].\n\nCITED LINKS\n[1] https://example.com\nSource: Scrape\nDescription: Release notes.';

describe('splitCoverageDigest', () => {
  it('splits a well-formed report into digest and body', () => {
    const { digest, body } = splitCoverageDigest(`${DIGEST}\n\n${BODY}`);
    expect(digest).toContain('Goal: establish the release timeline');
    expect(digest).toContain('Sources: 5');
    // The delimiters themselves are consumed, not handed on.
    expect(digest).not.toContain('COVERAGE DIGEST');
    expect(body).toBe(BODY);
  });

  it('tolerates the markdown decoration models add to the delimiters', () => {
    const decorated = `## COVERAGE DIGEST\nCovered: things\n**END COVERAGE DIGEST**\n\n${BODY}`;
    const { digest, body } = splitCoverageDigest(decorated);
    expect(digest).toBe('Covered: things');
    expect(body).toBe(BODY);
  });

  it('tolerates a short preamble before the digest and keeps it in the body', () => {
    // Models routinely open with "Here is my report:". Dropping that text would be a silent
    // content loss; the preamble belongs to the report.
    const { digest, body } = splitCoverageDigest(`Here is my report.\n\n${DIGEST}\n\n${BODY}`);
    expect(digest).toContain('Sources: 5');
    expect(body).toContain('Here is my report.');
    expect(body).toContain('The v4.2 release shipped');
  });

  it('ignores the phrase deep inside prose', () => {
    // A report ABOUT research tooling can discuss a "coverage digest" in its body. Matching
    // that would truncate everything before it out of the synthesis corpus.
    const report = `${'Filler sentence about the topic. '.repeat(60)}\nCOVERAGE DIGEST\nCovered: x\nEND COVERAGE DIGEST\ntail`;
    const { digest, body } = splitCoverageDigest(report);
    expect(digest).toBe('');
    expect(body).toBe(report);
  });

  it('refuses to split when the terminator is missing', () => {
    // Guessing where an unterminated block ends risks swallowing the findings. A report
    // that reaches the synthesizer whole is strictly better than one that reaches it short.
    const report = `COVERAGE DIGEST\nCovered: things\n\n${BODY}`;
    const { digest, body } = splitCoverageDigest(report);
    expect(digest).toBe('');
    expect(body).toBe(report);
  });

  it('refuses to split when the terminator is implausibly far away', () => {
    const report = `COVERAGE DIGEST\n${'x'.repeat(9000)}\nEND COVERAGE DIGEST\n\n${BODY}`;
    const { digest, body } = splitCoverageDigest(report);
    expect(digest).toBe('');
    expect(body).toBe(report);
  });

  it('caps an oversized digest without touching the body', () => {
    // A model that writes its findings inside the delimiters would otherwise reintroduce
    // exactly the unbounded routing input this protocol removes.
    const fat = `COVERAGE DIGEST\n${'y'.repeat(4000)}\nEND COVERAGE DIGEST\n\n${BODY}`;
    const { digest, body } = splitCoverageDigest(fat);
    expect(digest.length).toBeLessThanOrEqual(MAX_DIGEST_CHARS + 40);
    expect(digest).toContain('(digest truncated)');
    expect(body).toBe(BODY);
  });

  it('returns the report intact when the digest would consume all of it', () => {
    // Everything inside the delimiters and nothing after: taking the split would leave the
    // synthesizer with an empty report.
    const report = 'COVERAGE DIGEST\nCovered: everything\nEND COVERAGE DIGEST';
    const { digest, body } = splitCoverageDigest(report);
    expect(digest).toBe('');
    expect(body).toBe(report);
  });

  it('is a no-op on a report with no digest at all', () => {
    const { digest, body } = splitCoverageDigest(BODY);
    expect(digest).toBe('');
    expect(body).toBe(BODY);
  });

  it('handles empty input', () => {
    expect(splitCoverageDigest('')).toEqual({ digest: '', body: '' });
  });
});

describe('deriveCoverageDigest', () => {
  it('reports the topic line and the source count', () => {
    const digest = deriveCoverageDigest(BODY);
    expect(digest).toContain('Release timeline');
    expect(digest).toContain('Sources: 1');
  });

  it('says coverage is unknown rather than implying none', () => {
    // A router told "nothing here" re-delegates work already done; a router told "unverified"
    // weighs the real digests instead. The wording is the whole point of the fallback.
    expect(deriveCoverageDigest(BODY)).toMatch(/unknown/i);
  });

  it('does not present a citation line as the topic', () => {
    // A report that is nothing but a source list has no prose; reading its first line would
    // put a URL where the router expects a topic.
    const digest = deriveCoverageDigest('CITED LINKS\n[1] https://example.com\nSource: Scrape\nDescription: d.');
    expect(digest).not.toContain('https://example.com');
  });

  it('bounds a very long topic line', () => {
    const digest = deriveCoverageDigest(`${'z'.repeat(900)}\n\nbody`);
    expect(digest.length).toBeLessThan(400);
  });

  it('counts zero sources for an ungrounded report', () => {
    expect(deriveCoverageDigest('Some prose with no sources at all.')).toContain('Sources: 0');
  });
});

describe('formatDigestsForRouter', () => {
  it('labels each digest with its researcher id, in order', () => {
    const out = formatDigestsForRouter(new Map([['1.1', 'a'], ['2.1', 'b']]));
    expect(out).toBe('### Researcher 1.1\na\n\n### Researcher 2.1\nb');
  });

  it('renders empty for no digests', () => {
    expect(formatDigestsForRouter(new Map())).toBe('');
  });
});
