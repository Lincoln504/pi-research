/**
 * fetch_url — paging a long page into chunks the agent can walk through.
 *
 * No summarizer between the page and the agent: long pages are served in chunks
 * (`start` + `maxChars`), each cut at a natural boundary, with a footer giving the
 * exact offset to continue from and, on the first chunk, a heading outline with
 * offsets so the agent can jump straight to a section.
 */

import { fencedRanges } from './heuristics.ts';

export interface Chunk {
  start: number;
  end: number;
  text: string;
  total: number;
}

export interface OutlineEntry {
  level: number;
  title: string;
  offset: number;
}

export interface Paragraph {
  /** 1-based id, stable within a chunk. */
  id: number;
  /** Absolute offsets in the page text. */
  start: number;
  end: number;
  text: string;
}

/** Fraction of the window that must be kept before a boundary cut is accepted. */
const MIN_KEEP = 0.5;
/** A fence starting this far into the window is cut before; earlier ones are carried whole. */
const FENCE_CUT_MIN = 0.25;
/** A code block may push a chunk this far past maxChars rather than be split. */
const FENCE_OVERRUN = 1.5;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * Cut `text[start…]` to at most `maxChars` (code blocks may overrun, see below),
 * preferring, in order: a blank line, a line break, a space — each only if it
 * keeps at least half the window. Never splits a surrogate pair. A fenced code
 * block is not split when avoidable: cut before it, or carry it whole when it
 * starts near the chunk start and fits within 1.5× maxChars.
 */
export function sliceChunk(text: string, start: number, maxChars: number): Chunk {
  const total = text.length;
  const s = Math.max(0, Math.min(Math.floor(start), total));
  const size = Math.max(1, Math.floor(maxChars));
  const hardEnd = Math.min(total, s + size);
  if (hardEnd >= total) return { start: s, end: total, text: text.slice(s), total };

  const windowFloor = s + Math.max(1, Math.floor(size * MIN_KEEP));
  let end = hardEnd;
  const blank = text.lastIndexOf('\n\n', hardEnd - 2);
  if (blank >= windowFloor) {
    end = blank + 2;
  } else {
    const nl = text.lastIndexOf('\n', hardEnd - 1);
    if (nl >= windowFloor) {
      end = nl + 1;
    } else {
      const sp = text.lastIndexOf(' ', hardEnd - 1);
      if (sp >= windowFloor) end = sp + 1;
    }
  }

  // Fenced code block straddling the cut?
  const fence = fencedRanges(text).find(([fs, fe]) => fs < end && fe > end);
  if (fence) {
    const [fs, fe] = fence;
    if (fs >= s + Math.floor(size * FENCE_CUT_MIN)) {
      end = fs; // cut cleanly before the block
    } else if (fe - s <= Math.floor(size * FENCE_OVERRUN)) {
      end = Math.min(total, fe + (text[fe] === '\n' ? 1 : 0)); // carry the whole block
    }
    // else: a block much larger than a chunk — split it at the line cut above.
  }

  if (end <= s) end = hardEnd; // degenerate windows: always make progress
  if (end < total && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
  if (end <= s) end = Math.min(total, s + 2);
  return { start: s, end, text: text.slice(s, end), total };
}

/** ATX headings outside code fences, with offsets. Capped; keeps top levels first when over. */
export function buildOutline(text: string, maxEntries = 60): { entries: OutlineEntry[]; truncated: boolean } {
  const fences = fencedRanges(text);
  const entries: OutlineEntry[] = [];
  const re = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const offset = m.index;
    if (fences.some(([fs, fe]) => offset >= fs && offset < fe)) continue;
    const title = m[2]!.replace(/\s+/g, ' ').trim();
    if (title) entries.push({ level: m[1]!.length, title: title.slice(0, 120), offset });
  }
  if (entries.length <= maxEntries) return { entries, truncated: false };
  for (const maxLevel of [3, 2, 1]) {
    const kept = entries.filter((e) => e.level <= maxLevel);
    if (kept.length <= maxEntries) return { entries: kept, truncated: true };
  }
  return { entries: entries.filter((e) => e.level === 1).slice(0, maxEntries), truncated: true };
}

/** Split long paragraphs so a flagged id points at a reviewable span. */
const MAX_PARAGRAPH = 1500;

/**
 * Paragraphs of a chunk: blank-line separated, a fenced code block is one unit,
 * over-long paragraphs are split (at a line break or space when possible).
 */
export function splitParagraphs(chunk: Chunk): Paragraph[] {
  const text = chunk.text;
  const fences = fencedRanges(text);
  const spans: Array<[number, number]> = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && text[i] === '\n') i++;
    if (i >= text.length) break;
    const fence = fences.find(([fs]) => fs === i || (fs > i && text.slice(i, fs).trim() === ''));
    let end: number;
    if (fence && text.slice(i, fence[0]).trim() === '') {
      end = fence[1];
    } else {
      const blank = text.indexOf('\n\n', i);
      end = blank === -1 ? text.length : blank;
      // A fence opening inside this paragraph ends it (the fence is its own unit).
      const inner = fences.find(([fs]) => fs > i && fs < end);
      if (inner) end = inner[0];
    }
    if (end <= i) end = Math.min(text.length, i + 1);
    spans.push([i, end]);
    i = end;
  }

  const out: Paragraph[] = [];
  for (const [a, b] of spans) {
    let p = a;
    while (p < b) {
      let q = Math.min(b, p + MAX_PARAGRAPH);
      if (q < b) {
        const nl = text.lastIndexOf('\n', q);
        const sp = text.lastIndexOf(' ', q);
        const cut = nl > p + MAX_PARAGRAPH / 2 ? nl + 1 : sp > p + MAX_PARAGRAPH / 2 ? sp + 1 : q;
        q = cut;
      }
      const body = text.slice(p, q).replace(/\s+$/, '');
      if (body.trim()) {
        out.push({ id: out.length + 1, start: chunk.start + p, end: chunk.start + p + body.length, text: body });
      }
      p = q;
    }
  }
  return out;
}

/** Paragraph ids (within a chunk) containing any of the given absolute offsets. */
export function paragraphsAt(paragraphs: Paragraph[], offsets: number[]): number[] {
  const ids = new Set<number>();
  if (paragraphs.length === 0) return [];
  const lo = paragraphs[0]!.start;
  const hi = paragraphs[paragraphs.length - 1]!.end;
  for (const o of offsets) {
    if (o < lo || o >= hi) continue; // not in this chunk
    // Inside a paragraph, or in the blank gap before the next one.
    const p = paragraphs.find((x) => o >= x.start && o < x.end) ?? paragraphs.find((x) => x.start >= o);
    if (p) ids.add(p.id);
  }
  return [...ids].sort((a, b) => a - b);
}
