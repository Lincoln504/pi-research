/**
 * fetch_url — invisible Unicode.
 *
 * Characters a human reader never sees but a model reads can smuggle instructions
 * past both the user and any visual review. They have no legitimate use in text an
 * agent reads, so they are STRIPPED (not just flagged), and anything they encoded
 * is DECODED so the user can see what was hidden.
 *
 * Removed:
 *   - Unicode tag characters U+E0000–U+E007F ("ASCII smuggling": U+E0020–E007E
 *     mirror printable ASCII) — decoded to the hidden text.
 *   - Runs of 2+ variation selectors (U+FE00–FE0F, U+E0100–E01EF) — "emoji
 *     smuggling" encodes one byte per selector; decoded as UTF-8. A single
 *     selector is kept: FE0F/FE0E select emoji/text presentation, and E01xx
 *     Ideographic Variation Sequences are legitimate after CJK ideographs.
 *   - Zero-width space / word joiner / BOM / Mongolian vowel separator /
 *     invisible math operators — always.
 *   - ZWJ (U+200D) / ZWNJ (U+200C) only in runs of 2+ zero-width characters: a
 *     single ZWJ builds emoji sequences and a single ZWNJ is orthographic in
 *     Persian and Indic scripts, while binary zero-width encodings need runs.
 *   - Bidi embedding/override/isolate controls (U+202A–202E, U+2066–2069) —
 *     "Trojan Source" reordering. LRM/RLM (U+200E/U+200F) are kept (common in
 *     legitimate right-to-left text).
 *
 * Offsets in the findings are positions in the CLEANED text, so they line up with
 * everything downstream (chunking, paragraph ids).
 */

export interface HiddenMessage {
  kind: 'tag-characters' | 'variation-selectors';
  /** Decoded text (truncated to 500 chars). */
  text: string;
  /** Offset in the cleaned text where the run was removed. */
  offset: number;
}

export interface UnicodeFindings {
  hiddenMessages: HiddenMessage[];
  /** Zero-width characters removed. */
  zeroWidth: number;
  /** Bidi control characters removed. */
  bidiControls: number;
  /** Offsets (cleaned text) of removed zero-width runs and bidi controls (capped). */
  offsets: number[];
}

export interface CleanResult {
  text: string;
  findings: UnicodeFindings;
  /** Total code points removed. */
  removed: number;
}

const ALWAYS_ZERO_WIDTH = new Set([0x200b, 0x2060, 0xfeff, 0x180e, 0x2061, 0x2062, 0x2063, 0x2064]);
const JOINERS = new Set([0x200c, 0x200d]);
const isZeroWidth = (cp: number) => ALWAYS_ZERO_WIDTH.has(cp) || JOINERS.has(cp);
const isTag = (cp: number) => cp >= 0xe0000 && cp <= 0xe007f;
const isVariationSelector = (cp: number) => (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef);
const isBidiControl = (cp: number) => (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069);
const MAX_OFFSETS = 50;
const MAX_MESSAGE_CHARS = 500;

function variationSelectorByte(cp: number): number {
  return cp <= 0xfe0f ? cp - 0xfe00 : cp - 0xe0100 + 16;
}

export function stripInvisibleUnicode(input: string): CleanResult {
  const cps = Array.from(input, (ch) => ch.codePointAt(0)!);
  const out: string[] = [];
  let outLen = 0; // length of the cleaned text so far, in UTF-16 units
  const findings: UnicodeFindings = { hiddenMessages: [], zeroWidth: 0, bidiControls: 0, offsets: [] };
  let removed = 0;
  const noteOffset = () => {
    if (findings.offsets.length < MAX_OFFSETS && findings.offsets.at(-1) !== outLen) findings.offsets.push(outLen);
  };

  let i = 0;
  while (i < cps.length) {
    const cp = cps[i]!;

    if (isTag(cp)) {
      let decoded = '';
      while (i < cps.length && isTag(cps[i]!)) {
        const t = cps[i]!;
        if (t >= 0xe0020 && t <= 0xe007e) decoded += String.fromCharCode(t - 0xe0000);
        i++; removed++;
      }
      if (decoded.trim()) {
        findings.hiddenMessages.push({ kind: 'tag-characters', text: decoded.slice(0, MAX_MESSAGE_CHARS), offset: outLen });
      }
      continue;
    }

    if (isVariationSelector(cp)) {
      let j = i;
      while (j < cps.length && isVariationSelector(cps[j]!)) j++;
      if (j - i >= 2) {
        const bytes = Uint8Array.from(cps.slice(i, j).map(variationSelectorByte));
        const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/\p{C}/gu, '');
        if (decoded.trim()) {
          findings.hiddenMessages.push({ kind: 'variation-selectors', text: decoded.slice(0, MAX_MESSAGE_CHARS), offset: outLen });
        } else {
          noteOffset();
        }
        removed += j - i;
        i = j;
        continue;
      }
      // Single selector: presentation / ideographic variant — keep.
      const ch = String.fromCodePoint(cp);
      out.push(ch); outLen += ch.length; i++;
      continue;
    }

    if (isZeroWidth(cp)) {
      let j = i;
      while (j < cps.length && isZeroWidth(cps[j]!)) j++;
      const run = cps.slice(i, j);
      if (run.length === 1 && JOINERS.has(cp)) {
        // Lone ZWJ/ZWNJ: emoji sequences, Persian/Indic orthography — keep.
        out.push(String.fromCodePoint(cp)); outLen += 1; i++;
        continue;
      }
      noteOffset();
      findings.zeroWidth += run.length;
      removed += run.length;
      i = j;
      continue;
    }

    if (isBidiControl(cp)) {
      noteOffset();
      findings.bidiControls++;
      removed++;
      i++;
      continue;
    }

    const ch = String.fromCodePoint(cp);
    out.push(ch); outLen += ch.length; i++;
  }

  return { text: out.join(''), findings, removed };
}

/**
 * Render a string so invisible characters become visible — for showing the user
 * exactly what a page contained (review dialogs). Tags are decoded inline.
 */
export function revealInvisible(input: string): string {
  let out = '';
  let tagRun = '';
  const flushTags = () => {
    if (tagRun) { out += `[hidden tags: "${tagRun}"]`; tagRun = ''; }
  };
  for (const ch of input) {
    const cp = ch.codePointAt(0)!;
    if (isTag(cp)) {
      if (cp >= 0xe0020 && cp <= 0xe007e) tagRun += String.fromCharCode(cp - 0xe0000);
      continue;
    }
    flushTags();
    if (cp === 0x200b) out += '[ZWSP]';
    else if (cp === 0x200c) out += '[ZWNJ]';
    else if (cp === 0x200d) out += '[ZWJ]';
    else if (cp === 0x2060) out += '[WJ]';
    else if (cp === 0xfeff) out += '[BOM]';
    else if (isBidiControl(cp)) out += `[U+${cp.toString(16).toUpperCase()}]`;
    else if (isVariationSelector(cp) && cp !== 0xfe0f && cp !== 0xfe0e) out += `[VS${variationSelectorByte(cp) + 1}]`;
    else out += ch;
  }
  flushTags();
  return out;
}
