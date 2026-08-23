import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { logger } from '../logger.ts';
import { stripTrailingLlmPunctuation } from './url-utils.ts';

/**
 * Text Utilities
 *
 * Shared text extraction and formatting functions.
 */

/**
 * Extract text content from a message
 *
 * Handles various message content formats:
 * - String content (with tag-based thinking removal)
 * - Array of content blocks (TextContent, ThinkingContent, ToolCall, etc.)
 * - Accepts any object with a content field for robustness
 *
 * @param message - Message object with content field, or undefined/null
 * @returns Extracted text string, or empty string if invalid
 */
export function extractText(message: unknown): string {
  // Validate message exists and is an object
  if (!message || typeof message !== 'object') {
    return '';
  }

  const msg = message as Record<string, unknown>;
  const { content } = msg;

  // Handle string content
  if (typeof content === 'string') {
    return stripThinkingTags(content);
  }

  // Handle array of content blocks
  if (Array.isArray(content)) {
    try {
      return (content as unknown[])
        .filter((b) => b && typeof b === 'object' && (b as Record<string, unknown>)['type'] === 'text')
        .map((b) => {
          const blockObj = b as Record<string, unknown>;
          const text = blockObj['text'];
          // Ensure we also strip tags if the text block itself contains them (rare but possible)
          return typeof text === 'string' ? stripThinkingTags(text) : '';
        })
        .filter((t: string) => t.length > 0) // Filter empty strings
        .join('\n');
    } catch (_error) {
      // If array processing fails, return empty string
    }
  }

  // Unknown content format
  return '';
}

/**
 * Truncate content to at most `maxChars` characters, appending an explicit
 * `[content truncated: showing N of M chars]` marker so an LLM consuming the
 * text knows it is incomplete.
 *
 * Guarantees:
 * - Content at or under the cap is returned unchanged (no marker).
 * - Truncated output (body + marker) never exceeds `maxChars`, which makes the
 *   function idempotent — re-applying the same cap to already-truncated output
 *   is a no-op (no nested markers).
 * - Cuts at a clean boundary (last newline/space) when one exists in the final
 *   20% of the kept text, so words/lines are not split mid-token.
 */
export function truncateWithMarker(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;

  const total = content.length;
  const makeMarker = (kept: number) => `\n\n[content truncated: showing ${kept} of ${total} chars]`;
  // Reserve marker room using the longest possible marker (kept ≤ total, so the
  // digit count of `kept` never exceeds that of `total`).
  let keep = Math.max(0, maxChars - makeMarker(total).length);
  // slice() counts UTF-16 code units, so the cut can land between the halves of a
  // surrogate pair — a lone high surrogate in the body is invalid text that some
  // providers reject (400) when it reaches a JSON payload. Backing off one unit
  // restores well-formed text. The whitespace-boundary path below cannot split a
  // pair: it cuts immediately before a BMP whitespace character.
  const lastKeptUnit = content.charCodeAt(keep - 1);
  if (lastKeptUnit >= 0xd800 && lastKeptUnit <= 0xdbff) keep -= 1;
  let body = content.slice(0, keep);
  // Prefer a clean boundary near the cut point.
  const boundary = Math.max(body.lastIndexOf('\n'), body.lastIndexOf(' '));
  if (boundary > keep * 0.8) body = body.slice(0, boundary);
  return body + makeMarker(body.length);
}

/**
 * Robustly remove thinking/reasoning tags from a string.
 * Handles <thought>, <thinking>, and <reasoning> tags (case-insensitive).
 */
export function stripThinkingTags(text: string): string {
  if (!text) return '';
  
  // Replace tags and their content: <thought>...</thought>, etc.
  // Using dotAll (s flag) to handle multi-line thinking blocks.
  // Also handles unclosed tags at the end of the string (truncated responses).
  return text
    .replace(/<thought>[\s\S]*?(?:<\/thought>|$)/gi, '')
    .replace(/<thinking>[\s\S]*?(?:<\/thinking>|$)/gi, '')
    .replace(/<reasoning>[\s\S]*?(?:<\/reasoning>|$)/gi, '')
    .trim();
}

/**
 * Ensures the assistant completed successfully and returns the text content.
 * Throws an error if the assistant failed or stopped with an error.
 * 
 * @param session - The agent session to check
 * @param label - Label for error reporting
 * @returns The extracted text content
 * @throws Error if assistant failed
 */
export function ensureAssistantResponse(session: AgentSession, label: string): string {
  const msgs = session.messages;
  const last = [...msgs].reverse().find((m) => m.role === 'assistant') as AssistantMessage | undefined;

  if (!last) {
    throw new Error(`${label}: No assistant response found`);
  }

  // Check for explicit error stop reason or error message. An aborted session with an
  // errorMessage is an interruption, not a provider error — fall through so any partial
  // text it produced is salvaged below (and, if empty, reported as an abort not a model fault).
  if (last.stopReason === 'error' || (last.errorMessage && last.stopReason !== 'aborted')) {
    const msg = last.errorMessage || 'Unknown error';
    if (msg.includes('429')) {
      throw new Error(`Model API rate limit (429) — wait a moment and retry. Details: ${msg}`);
    }
    throw new Error(`${label}: Provider error - ${msg}`);
  }

  // Warn if the response was truncated due to token limit
  if (last.stopReason === 'length') {
    const text = extractText(last);
    if (text.trim()) {
      logger.warn(`${label}: Response truncated by token limit — returning partial result`);
      return text;
    }
    throw new Error(`${label}: Response was truncated by token limit and produced no usable text.`);
  }

  const text = extractText(last);
  if (!text.trim()) {
    // An aborted session with no salvageable text was interrupted mid-turn (quit/SIGTERM
    // during research, or a timeout abort) before the model emitted its final answer. That
    // is NOT a model-capability failure — surface an explicit "Aborted" so callers skip
    // retries (see researcher-executor) instead of blaming the model with the message below.
    if (last.stopReason === 'aborted') {
      throw new Error(`${label}: Aborted`);
    }
    // zero text content blocks in the final assistant message. This typically means
    // all tool calls failed, or the session ended without a visible response.
    throw new Error(
      `${label}: produced no text output — the model returned no final text block after its tool calls. ` +
      `This is usually a model-capability issue (a very small or thinking-only model that doesn't emit a final ` +
      `answer after using tools), or every tool call in the turn failed. Try a more capable model or retry.`
    );
  }
  return text;
}

/**
 * Format a timestamp as a human-readable relative time string.
 */
export function formatTimeAgo(isoTimestamp: string): string {
  const parsed = new Date(isoTimestamp).getTime();
  if (Number.isNaN(parsed)) return 'unknown';
  const diffMs = Date.now() - parsed;
  const diffMinutes = Math.floor(diffMs / 60_000);
  if (diffMinutes < 1) return 'just now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
}

/**
 * Format a duration in ms as a human-readable string (e.g., "12.3s", "1m 23s", "2h 15m").
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  // Round the total first, then derive minutes/seconds from that integer —
  // rounding remainingSeconds independently of minutes let e.g. 59.6s round up
  // to a nonsensical "Xm 60s" instead of rolling over to the next minute.
  const totalSeconds = Math.round(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

import * as path from 'node:path';

/**
 * Consistently normalize a workspace path for database storage and filtering.
 * Resolves to absolute path and removes trailing separators.
 */
export function normalizeWorkspacePath(wsPath: string): string {
  if (!wsPath) return '';
  const resolved = path.resolve(wsPath);
  // Normalize trailing slash: /path/to/dir/ -> /path/to/dir
  return (resolved.endsWith(path.sep) && resolved.length > 1) 
    ? resolved.slice(0, -1) 
    : resolved;
}

export interface Citation {
  url: string;
  description: string;
  source?: string;
  /** The number the report actually wrote for this entry (e.g. 3 for `[3]`). Used to remap
   *  inline `[N]` by the written label, not list position, so non-sequential numbering maps right. */
  number?: number;
}

/**
 * A citation URL is only plausible if it parses and has a real host (a dot in
 * the hostname). This rejects fragments like `https://www` that occur when an
 * LLM soft-wraps or truncates a URL in its CITED LINKS — without this guard such
 * a fragment becomes a garbage citation AND shifts every downstream global ID.
 */
function isPlausibleCitationUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname.includes('.');
  } catch {
    return false;
  }
}

/**
 * Offset of the LAST line-leading "CITED LINKS" section header in a report, or -1
 * when none is present.
 *
 * ONLY an all-caps "CITED LINKS" at the start of a line (optionally after markdown
 * heading `#` / blockquote `>` / bold `**` markers and whitespace) counts as the
 * section marker — NOT an incidental lowercase "...the cited links below..." in
 * prose. An unanchored, case-insensitive /CITED LINKS/i match would fire on such a
 * mention and, with a trailing `[\s\S]*$`, silently truncate (or mis-parse) the
 * whole report body from that point. Matching a header line and taking the LAST
 * occurrence (the real trailing section) avoids that while staying idempotent
 * against the `CITED LINKS\n...` block that formatCitedLinks() emits.
 */
export function lastCitedLinksHeaderIndex(text: string): number {
  return lastCitedLinksHeader(text).textStart;
}

/**
 * Both offsets of the last CITED LINKS header: `textStart` points at the 'C'
 * (what parseCitations slices FROM), `lineStart` points at the start of the
 * header line BEFORE any `#`/`>`/`**` markers (what body-replacement slices TO).
 * Slicing the body at textStart left the tolerated markdown marker dangling at
 * the end of the body — the rebuilt report then carried a stray `##` or `**`
 * line whenever the model wrote `## CITED LINKS` instead of the plain form.
 */
export function lastCitedLinksHeader(text: string): { lineStart: number; textStart: number } {
  // Case-insensitive but LINE-LEADING: a mid-prose "...the cited links below..." has
  // non-whitespace before it on the line, so it cannot match — only a header at the
  // start of a line (after optional markdown markers) does.
  const re = /(^|\n)([ \t]*(?:#{1,6}[ \t]*|>[ \t]*|\*\*)?)CITED LINKS\b/gi;
  let lineStart = -1;
  let textStart = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    lineStart = m.index + m[1]!.length;
    // Offset of the 'C' in CITED LINKS = match start + leading newline + markers.
    textStart = m.index + m[1]!.length + m[2]!.length;
  }
  return { lineStart, textStart };
}

/**
 * A first-person opener that announces the report instead of being part of it:
 * "I have gathered extensive material… Let me now synthesize my findings into a
 * comprehensive report."
 *
 * Deliberately narrow. It has to match a line that is BOTH first-person AND about the
 * act of reporting, because the only available response is to delete the line, and the
 * cost of deleting a real one is losing content nothing else can recover.
 */
const REPORT_NARRATION_OPENER = /^(?:I|I'll|I'm|Let me|Now I|Next I|First,? I)\b/i;
const REPORT_NARRATION_SUBJECT =
  /\b(?:report|synthesi[sz]\w*|findings|material|sources|scraped|gathered|research\w*|summar\w+)\b/i;

/**
 * Remove a leading line that narrates the report rather than being part of it.
 *
 * The researcher prompt forbids this, and the instruction is not reliably obeyed: across
 * live quick runs the delivered document repeatedly opened with "I have gathered
 * sufficient material… I will now synthesize the full report." Quick mode has no
 * synthesis step behind it to absorb that, so it reaches the reader as the report's
 * first line.
 *
 * Every condition here narrows a DESTRUCTIVE action, so each one is required rather than
 * scored: the segment must be a single line, must be separated from the report by a
 * blank line, must read as first-person narration ABOUT reporting, and must leave
 * something behind. A report that opens correctly — with a topic title, as the format
 * requires — matches none of them.
 *
 * @returns the body with the preamble removed, and the preamble itself (empty when
 *          nothing was stripped) so callers can log and count what they dropped.
 */
export function stripReportPreamble(text: string): { body: string; preamble: string } {
  const trimmed = text.trimStart();
  const breakAt = trimmed.indexOf('\n\n');
  if (breakAt < 0) return { body: text, preamble: '' };

  const head = trimmed.slice(0, breakAt).trim();
  const rest = trimmed.slice(breakAt + 2).trimStart();
  if (head.includes('\n')) return { body: text, preamble: '' };
  // Something has to be left. There is deliberately no LENGTH floor beyond that: a
  // short remainder is the answer ("Paris is the capital of France."), and keeping the
  // narration to pad it out would both deliver the wrong text and let that narration's
  // full stop satisfy the analysis check that runs on the result.
  if (!rest) return { body: text, preamble: '' };
  if (!REPORT_NARRATION_OPENER.test(head)) return { body: text, preamble: '' };
  if (!REPORT_NARRATION_SUBJECT.test(head)) return { body: text, preamble: '' };

  return { body: rest, preamble: head };
}

/**
 * The prose body of a synthesis: everything before its CITED LINKS section, trimmed.
 * Returns the whole text when there is no such section.
 *
 * Exists to measure how much the model ACTUALLY wrote. Length alone cannot do that,
 * because the engine rebuilds and appends the citation list itself — a report whose
 * body is one title line still comes out kilobytes long once that block lands, which
 * is precisely how a synthesis containing no analysis reached users looking complete.
 */
export function synthesisProseBody(text: string): string {
  const { lineStart } = lastCitedLinksHeader(text);
  return (lineStart < 0 ? text : text.slice(0, lineStart)).trim();
}

/**
 * Whether a synthesis carries no actual analysis — a heading with nothing under it,
 * a stray sentence fragment, or an empty string.
 *
 * Two INDEPENDENT signals, either of which is enough, so the check does not rest on a
 * single tuned number:
 *
 *  - Volume. Less prose than a real report could possibly contain. Pass 0 to DISABLE
 *    this signal, which callers must do wherever no length data justifies a floor:
 *    a wrongly-flagged report is worse than a missed one when the only available
 *    response is to warn the reader about output that is actually fine.
 *  - Structure. No sentence ever ends. Every observed failure was a bare title line,
 *    which has no terminator at all; any genuine report has many. This one needs no
 *    threshold and would catch a title of any length.
 *
 * Measured on the prose only — the text before CITED LINKS — because the engine
 * rebuilds and appends the source list itself, which pads a one-line failure out to
 * kilobytes and is exactly how such a report reached users looking complete.
 */
export function isAnalysisFreeSynthesis(text: string, minProseChars: number): boolean {
  const prose = synthesisProseBody(text);
  // Drop markdown heading markers and blockquote/bold decoration before judging, so a
  // model that writes "## Title" is measured the same as one that writes "Title".
  const stripped = prose.replace(/^[ \t]*(?:#{1,6}[ \t]*|>[ \t]*|\*\*)/gm, '').trim();
  if (minProseChars > 0 && stripped.length < minProseChars) return true;
  // A report with no sentence-ending punctuation anywhere is a heading, a fragment or a
  // list of bare labels — never analysis. The terminator set must not assume Latin
  // punctuation: a report written in a script that ends sentences with a danda, an
  // Arabic full stop or a CJK full stop is a correct report, and this signal is the only
  // one quick mode runs, where a false positive tells the reader a good answer is
  // untrustworthy.
  if (!/[.!?。！？।॥۔؟።]/.test(stripped)) return true;
  return false;
}

/**
 * Parses the CITED LINKS section from a researcher report, extracting URLs, sources, and their descriptions.
 * Handles both single-line 'URL - description' and multi-line 'Source:'/'Description:' formats.
 */
export function parseCitations(report: string): Citation[] {
  const headerIdx = lastCitedLinksHeaderIndex(report);
  if (headerIdx < 0) return [];
  const section = report.slice(headerIdx);

  const citations: Citation[] = [];
  // Match a list marker [N] or N. (optionally **-wrapped) ONLY at the start of a line.
  // Entries in the CITED LINKS section are always line-leading, so anchoring to line
  // start (^ with the `m` flag) is loss-free — and critically it stops the bare "N."
  // form from matching a digits-then-dot run INSIDE a URL (e.g. `report-2024.pdf`,
  // `/v2.0/`, or an IP literal `192.168.1.10`), which previously truncated or dropped
  // those citations. The split and the parallel number-capture regex MUST stay
  // structurally identical so blocks[i] and writtenNumbers[i] remain index-aligned.
  const blocks = section.split(/^[^\S\n]*(?:\*\*)?[^\S\n]*(?:\[\d+\]|\d+\.)[^\S\n]*(?:\*\*)?/m).slice(1);
  // Capture the written number for each delimiter in parallel, using a SEPARATE global+capturing
  // regex (adding a capture group to the split pattern above would inject the captures into the
  // split output and break block indexing). blocks[i] is the content after delimiter i, so
  // writtenNumbers[i] is blocks[i]'s label — used to remap inline [N] by label, not position.
  const writtenNumbers = [...section.matchAll(/^[^\S\n]*(?:\*\*)?[^\S\n]*(?:\[(\d+)\]|(\d+)\.)[^\S\n]*(?:\*\*)?/gm)]
    .map(m => parseInt(m[1] ?? m[2] ?? '', 10));

  for (let bi = 0; bi < blocks.length; bi++) {
    const block = blocks[bi]!;
    const writtenNumber = Number.isFinite(writtenNumbers[bi]) ? writtenNumbers[bi] : undefined;
    const lines = block.trim().split('\n');
    if (lines.length === 0) continue;
    
    const firstLine = lines[0]!.trim();
    let url: string;
    let desc = '';
    let source = '';
    
    // Handles both plain inline format (URL — desc) and the format produced by
    // the researcher prompt template: URL [Source: Scrape] — desc.
    // Group 1: URL, Group 2: optional source tag contents, Group 3: description.
    const inlineMatch = /^(https?:\/\/[^\s\n]+)(?:\s+\[Source:\s*([^\]]*)\])?(?:\s*[—–-]\s*([^\n]*))?/.exec(firstLine);
    if (inlineMatch) {
      // Balance-aware trailing-punctuation strip (shared with normalizeUrl): a BLIND
      // ')' strip here truncated balanced-paren URLs — e.g. Wikipedia's
      // "…/Python_(programming_language)" — before normalizeUrl ever saw them, shipping
      // a broken 404 in the CITED LINKS section. stripTrailingLlmPunctuation removes a
      // ')' only when unbalanced and preserves unreserved trailing '_'/'~'.
      url = stripTrailingLlmPunctuation(inlineMatch[1]!.trim());
      source = (inlineMatch[2]?.trim() || '');
      desc = (inlineMatch[3]?.trim() || '').replace(/[*_~`]+$/, '');
    } else {
      const candidateUrl = stripTrailingLlmPunctuation(firstLine.split(/\s+/)[0]!.trim());
      if (!candidateUrl.startsWith('http')) continue;
      url = candidateUrl;
    }
    
    const descLines: string[] = [];
    let foundDescTag = false;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]!.trim();
      if (line.match(/^Source:/i)) {
        source = line.replace(/^Source:\s*/i, '').trim();
        continue;
      }
      if (!foundDescTag) {
        if (line.match(/^Description:/i)) {
          foundDescTag = true;
          descLines.push(line.replace(/^Description:\s*/i, ''));
        }
      } else {
        descLines.push(line);
      }
    }
    
    if (descLines.length > 0) {
      desc = descLines.join('\n').trim();
    }
    
    if (url && isPlausibleCitationUrl(url)) {
      citations.push({ url, description: desc, source, number: writtenNumber });
    }
  }
  return citations;
}
