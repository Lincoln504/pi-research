/**
 * fetch_url — text hidden from human readers but present in what the agent reads.
 *
 * A classic indirect-injection carrier: instructions in an element a browser never
 * shows (display:none, zero font size, positioned off-screen...) still come out of
 * HTML→Markdown conversion, so the agent reads them while a human skimming the
 * page does not. This finds such passages and reports ONLY those that actually
 * survive into the Markdown (text in dropped elements never reaches the agent).
 *
 * Scope (v1): the `hidden` attribute and inline `style` rules. Class/stylesheet-
 * based hiding needs a CSS cascade and is not evaluated (documented limitation).
 * `aria-hidden` is deliberately ignored: it hides content from screen readers,
 * not from sighted readers. Screen-reader-only text (clip/sr-only classes) is
 * visually hidden but legitimate accessibility, so it only counts when long.
 *
 * Output is a HINT for the agent and the safety checker, never a verdict.
 */

import { stripInvisibleUnicode } from './unicode.ts';

export interface HiddenPassage {
  /** Why the element is hidden (e.g. "display:none"). */
  reason: string;
  /** Normalized text of the hidden element (truncated). */
  text: string;
  /** Offset of the passage in the Markdown the agent receives. */
  offset: number;
}

export interface HiddenTextResult {
  passages: HiddenPassage[];
  /** True when the HTML was too large to analyse. */
  skipped: boolean;
}

/** Above this the analysis is skipped (jsdom parse cost), not the fetch. */
export const MAX_HTML_FOR_ANALYSIS = 5 * 1024 * 1024;
const MIN_TEXT = 20;
const MIN_TEXT_SR_ONLY = 80;
const MAX_PASSAGES = 30;
const MAX_PASSAGE_CHARS = 300;
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'HEAD', 'META', 'LINK', 'IFRAME', 'OBJECT', 'EMBED']);
const SR_ONLY_CLASS = /(?:^|\s)(?:sr-only|visually-hidden|screen-reader-text|screenreader-only|a11y-hidden)(?:\s|$)/i;

/** Returns why an element is hidden from sighted readers, or null. */
export function hiddenReason(el: { getAttribute(name: string): string | null; hasAttribute(name: string): boolean }): { reason: string; srOnly: boolean } | null {
  if (el.hasAttribute('hidden')) return { reason: 'hidden attribute', srOnly: false };
  const style = (el.getAttribute('style') ?? '').toLowerCase().replace(/\s+/g, '');
  if (style) {
    if (/(?:^|;)display:none/.test(style)) return { reason: 'display:none', srOnly: false };
    if (/(?:^|;)visibility:(?:hidden|collapse)/.test(style)) return { reason: 'visibility:hidden', srOnly: false };
    if (/(?:^|;)opacity:0?\.?0*(?:;|$|!)/.test(style)) return { reason: 'opacity:0', srOnly: false };
    if (/(?:^|;)font-size:0(?:\.0+)?(?:px|em|rem|pt|%)?(?:;|$|!)/.test(style)) return { reason: 'font-size:0', srOnly: false };
    if (/(?:^|;)color:(?:transparent|rgba\([^)]*,0(?:\.0+)?\))/.test(style)) return { reason: 'transparent text', srOnly: false };
    const off = /(?:^|;)(?:left|top|right|text-indent|margin-left|margin-top):-(\d+(?:\.\d+)?)(px|em|rem)/.exec(style);
    if (off) {
      const n = Number(off[1]);
      if ((off[2] === 'px' && n >= 500) || (off[2] !== 'px' && n >= 50)) return { reason: 'positioned off-screen', srOnly: false };
    }
    if (/(?:^|;)(?:width|height|max-width|max-height):0(?:px)?(?:;|$|!)/.test(style) && /overflow:hidden/.test(style)) {
      return { reason: 'zero size', srOnly: /clip/.test(style) };
    }
    if (/(?:^|;)clip:rect\(0/.test(style) || /(?:^|;)clip-path:inset\(50%/.test(style)) {
      return { reason: 'visually hidden (clip)', srOnly: true };
    }
  }
  if (SR_ONLY_CLASS.test(el.getAttribute('class') ?? '')) return { reason: 'screen-reader-only class', srOnly: true };
  return null;
}

/** Whitespace-collapsed, with invisible Unicode removed the same way the Markdown was cleaned. */
function normalize(s: string): string {
  return stripInvisibleUnicode(s).text.replace(/\s+/g, ' ').trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Offset of `text` in the Markdown, tolerant of the markup conversion adds
 * between words (emphasis, link brackets, line breaks). -1 when not present.
 */
export function locateInMarkdown(text: string, markdown: string): number {
  // Blank out link/image targets "](...)" with same-length padding: they sit
  // between the words of the visible text, and padding keeps offsets exact.
  const projected = markdown.replace(/\]\([^)\n]*\)/g, (m) => ' '.repeat(m.length));
  const words = text.split(' ').filter((w) => /[\p{L}\p{N}]/u.test(w));
  if (words.length >= 3) {
    const pattern = words.slice(0, 6).map(escapeRegExp).join('[^\\p{L}\\p{N}]{1,40}');
    const m = new RegExp(pattern, 'u').exec(projected);
    return m ? m.index : -1;
  }
  // Few/no spaces (CJK, one long token): plain substring on a prefix.
  const probe = text.slice(0, 24);
  return probe ? markdown.indexOf(probe) : -1;
}

/**
 * @param markdown the CLEANED Markdown (after stripInvisibleUnicode) — offsets are
 *                 reported in it.
 */
export async function findHiddenPassages(html: string, markdown: string): Promise<HiddenTextResult> {
  if (!html) return { passages: [], skipped: false };
  if (html.length > MAX_HTML_FOR_ANALYSIS) return { passages: [], skipped: true };

  const { JSDOM } = await import('jsdom');
  // Default JSDOM options: scripts are NOT executed and subresources are NOT
  // loaded — this is a pure parse of the bytes already fetched.
  const dom = new JSDOM(html);
  try {
    const passages: HiddenPassage[] = [];
    type DomElement = InstanceType<typeof dom.window.Element>;
    const visit = (el: DomElement): void => {
      if (passages.length >= MAX_PASSAGES) return;
      if (SKIP_TAGS.has(el.tagName.toUpperCase())) return;
      const hidden = hiddenReason(el);
      if (hidden) {
        const text = normalize(el.textContent ?? '');
        if (text.length >= (hidden.srOnly ? MIN_TEXT_SR_ONLY : MIN_TEXT)) {
          const offset = locateInMarkdown(text, markdown);
          if (offset >= 0) {
            passages.push({ reason: hidden.reason, text: text.slice(0, MAX_PASSAGE_CHARS), offset });
          }
        }
        return; // outermost hidden element only
      }
      for (const child of Array.from(el.children)) visit(child);
    };
    const body = dom.window.document.body;
    if (body) visit(body);
    passages.sort((a, b) => a.offset - b.offset);
    return { passages, skipped: false };
  } finally {
    dom.window.close();
  }
}
