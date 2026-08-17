/**
 * Coverage digests — the routing half of the evaluator's input.
 *
 * A researcher emits a short, structured account of what it covered at the HEAD of its
 * report, delimited by `COVERAGE DIGEST` / `END COVERAGE DIGEST`. The digest is split off
 * when the report is stored, so every consumer of a report body sees one without routing
 * metadata in it. The router reads a fresh report in full WITH its digest beside it, and
 * represents every earlier round by digest alone; the synthesizer reads bodies only.
 *
 * Why the head and not the tail: the tail already belongs to `CITED LINKS`, and a report
 * that gets truncated mid-write (timeout, token ceiling — see researcher-executor's
 * partial-report path) loses its tail first. A digest at the head survives truncation,
 * which is exactly the case where the router most needs to know what was and wasn't
 * established.
 *
 * Everything here is defensive: a missing, unterminated, or oversized digest must degrade
 * to a usable router input, never to a lost report body. The report is the run's product;
 * the digest is an optimization.
 */

import { parseCitations, lastCitedLinksHeaderIndex } from './text-utils.ts';

/** Opening delimiter, matched line-leading and case-insensitively. */
export const COVERAGE_DIGEST_HEADER = 'COVERAGE DIGEST';

/** Closing delimiter. Required — see `splitCoverageDigest`. */
export const COVERAGE_DIGEST_TERMINATOR = 'END COVERAGE DIGEST';

/**
 * How far into the report the opening delimiter may appear and still count.
 *
 * The digest is specified to be the first thing in the report, but models routinely emit
 * a short preamble ("Here is my report:") ahead of it. This window tolerates that while
 * refusing to match the phrase occurring incidentally in the middle of prose — a report
 * ABOUT research methodology could well discuss a "coverage digest", and treating that as
 * a delimiter would silently truncate everything before it out of the synthesis corpus.
 */
const DIGEST_HEAD_WINDOW_CHARS = 600;

/**
 * Ceiling on the digest text handed to the router.
 *
 * A well-formed digest is a handful of lines. A digest much larger than this means the
 * model wrote its findings inside the delimiters, which would reintroduce exactly the
 * unbounded routing input this protocol exists to remove. The body is unaffected — it is
 * whatever follows the terminator either way — so capping here costs nothing but router
 * detail.
 */
export const MAX_DIGEST_CHARS = 2400;

/**
 * Terminator must appear within this distance of the header for the block to be treated
 * as a digest. Bounds the damage from a model that writes the opening delimiter, forgets
 * the closing one, and happens to write `END COVERAGE DIGEST` much later (or from a
 * report that quotes both delimiters while discussing this very protocol).
 */
const MAX_DIGEST_BLOCK_CHARS = 8000;

/**
 * The `{{digest_section}}` block of the researcher prompt, for a run that has a research
 * lead to route (depth 1+).
 *
 * Left EMPTY for quick research: that mode has no lead and no second round, its report goes
 * straight to the user, and asking for routing metadata there would spend output tokens on
 * a reader that does not exist — while telling the model about a "research lead" that is
 * not part of its run.
 */
export const RESEARCHER_DIGEST_SECTION = `Your report has three parts in this exact order: a COVERAGE DIGEST block, the report body, and the CITED LINKS list.

### Part 1 — COVERAGE DIGEST (first, mandatory)

Open the report with this block, exactly as shown. The research lead reads it to decide what still needs investigating. On the round your report arrives the lead reads the digest alongside the full report and checks one against the other; on every later round it sees ONLY this digest — so anything you leave out of it is invisible to every decision after the first.

${COVERAGE_DIGEST_HEADER}
Goal: [your assigned goal, restated in one line]
Covered: [the specific topics you actually established from sources, separated by semicolons — be concrete, name the things you found out, not the areas you looked at]
Unsubstantiated: [claims you searched for but could not ground in any source; write "none" if there are none]
Gaps: [what a follow-up researcher would still need to investigate on this goal; write "none" if your goal is fully covered]
Sources: [the number of entries in your CITED LINKS list]
${COVERAGE_DIGEST_TERMINATOR}

Rules for the digest:
- Keep it under 150 words total. It is an index, not a summary — no [N] citations, no findings prose, no URLs.
- Be honest about \`Gaps\` and \`Unsubstantiated\`. Claiming full coverage you do not have is the single most damaging thing you can write here: it argues for ending the research on this topic, and after the round it arrives there is no report left for the lead to check the claim against.
- Write both delimiter lines exactly, in capitals, each on its own line.

### Part 2 — Report body

`;

/** Line-leading delimiter matcher, tolerating the markdown decoration models add. */
function delimiterRegex(word: string): RegExp {
  return new RegExp(`(^|\\n)([ \\t]*(?:#{1,6}[ \\t]*|>[ \\t]*|\\*\\*[ \\t]*)?)${word}\\b`, 'i');
}

export interface SplitReport {
  /** Digest text WITHOUT the delimiter lines, trimmed and capped. Empty when absent. */
  digest: string;
  /** The report body with the digest block removed. Never empty unless the input was. */
  body: string;
}

/**
 * Split a researcher report into its coverage digest and its body.
 *
 * Both delimiters are required. A header with no terminator is treated as NO digest and
 * the report is returned intact: the alternative — guessing where the block ends — risks
 * swallowing the findings, and a report that reaches the synthesizer whole is strictly
 * better than one that reaches it short.
 */
export function splitCoverageDigest(report: string): SplitReport {
  if (!report) return { digest: '', body: report ?? '' };

  const headerMatch = delimiterRegex(COVERAGE_DIGEST_HEADER).exec(report);
  if (!headerMatch) return { digest: '', body: report };

  const lineStart = headerMatch.index + headerMatch[1]!.length;
  if (lineStart > DIGEST_HEAD_WINDOW_CHARS) return { digest: '', body: report };

  // Search for the terminator strictly AFTER the header line, so `END COVERAGE DIGEST`
  // cannot match the header's own trailing text.
  const afterHeader = lineStart + headerMatch[2]!.length + COVERAGE_DIGEST_HEADER.length;
  const rest = report.slice(afterHeader);
  const endMatch = delimiterRegex(COVERAGE_DIGEST_TERMINATOR).exec(rest);
  if (!endMatch) return { digest: '', body: report };

  const endLineStart = endMatch.index + endMatch[1]!.length;
  if (endLineStart > MAX_DIGEST_BLOCK_CHARS) return { digest: '', body: report };

  const digestRaw = rest.slice(0, endLineStart).trim();
  // Consume the terminator's WHOLE line, not just the matched word: a model that writes
  // `**END COVERAGE DIGEST**` matches on the leading marker and would otherwise leave the
  // trailing `**` dangling at the head of the body. The terminator line is delimiter, so
  // none of it belongs to the report.
  const afterWord = endMatch.index + endMatch[0]!.length;
  const nextNewline = rest.indexOf('\n', afterWord);
  const bodyAfter = nextNewline < 0 ? '' : rest.slice(nextNewline + 1);

  // Anything the model wrote BEFORE the digest (a preamble) is kept — it is part of the
  // report, and dropping content is never the safe default here.
  const bodyBefore = report.slice(0, lineStart);
  const body = `${bodyBefore}${bodyAfter}`.trim();

  const digest = digestRaw.length > MAX_DIGEST_CHARS
    ? `${digestRaw.slice(0, MAX_DIGEST_CHARS).trimEnd()}\n(digest truncated)`
    : digestRaw;

  // A digest is only worth having if a body survives it. If the "body" came out empty the
  // model put the entire report inside the delimiters; return the original so nothing is
  // lost, and let the derived digest below serve routing.
  if (!body) return { digest: '', body: report };

  return { digest, body };
}

/**
 * Build a minimal digest for a report that carries none.
 *
 * Reached for older/partial reports and for models that ignore the format instruction.
 * The router must never be blind to a researcher that actually ran, so this derives the
 * two facts that can be read off any report mechanically — its opening topic line and how
 * many sources it cited — and says plainly that the rest is unknown. A router told
 * "coverage unknown" delegates; a router told nothing assumes the gap was filled.
 */
export function deriveCoverageDigest(body: string): string {
  const citationCount = parseCitations(body).length;

  // The report's first line is its topic title by the researcher prompt's format. Read it
  // from the prose region only — a report that is nothing BUT a CITED LINKS section would
  // otherwise present a URL line as its topic.
  const citedIdx = lastCitedLinksHeaderIndex(body);
  const prose = citedIdx >= 0 ? body.slice(0, citedIdx) : body;
  const firstLine = prose
    .split('\n')
    .map((l) => l.replace(/^[#>*\s]+/, '').trim())
    .find((l) => l.length > 0) ?? '';

  const topic = firstLine.length > 200 ? `${firstLine.slice(0, 200).trimEnd()}…` : firstLine;

  return [
    `Covered: ${topic || 'unknown — the report has no readable topic line'}`,
    `Gaps: unknown — this researcher emitted no coverage digest`,
    `Sources: ${citationCount}`,
  ].join('\n');
}

/**
 * Render the router's view of the run: one block per researcher, in report order.
 *
 * Deliberately mirrors the findings block's `### Researcher <id>` shape so the router's
 * researcher ids line up with the ids the synthesizer and the query history already use.
 */
export function formatDigestsForRouter(digests: ReadonlyMap<string, string>): string {
  if (digests.size === 0) return '';
  return Array.from(digests.entries())
    .map(([id, digest]) => `### Researcher ${id}\n${digest}`)
    .join('\n\n');
}
