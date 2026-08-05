import { parseCitations, lastCitedLinksHeaderIndex, type Citation } from './text-utils.ts';
import { normalizeUrl } from './shared-links.ts';

export interface GlobalCitation extends Citation {
  id: number;
}

/**
 * Normalizes citations across multiple reports.
 * 
 * 1. Extracts all citations from all reports.
 * 2. Deduplicates URLs and assigns global IDs.
 * 3. Replaces local citations [N] in each report with global IDs [G].
 * 4. Removes the local CITED LINKS section from each report.
 * 
 * @param reports - Map of researcher ID to report content
 * @returns Object containing normalized reports and the global citation list
 */
// ReadonlyMap: this only reads `reports` (it returns a NEW normalizedReports map),
// and callers now pass a read-only view to avoid create-on-read side effects.
export function normalizeCitations(reports: ReadonlyMap<string, string>): {
  normalizedReports: Map<string, string>;
  globalCitations: GlobalCitation[];
} {
  const globalCitations: GlobalCitation[] = [];
  const urlToGlobalId = new Map<string, number>();
  const normalizedReports = new Map<string, string>();

  // First pass: Collect all unique URLs and assign global IDs
  for (const report of reports.values()) {
    const citations = parseCitations(report);
    for (const cit of citations) {
      const normUrl = normalizeUrl(cit.url);
      if (!urlToGlobalId.has(normUrl)) {
        const id = globalCitations.length + 1;
        urlToGlobalId.set(normUrl, id);
        globalCitations.push({
          id,
          url: cit.url,
          description: cit.description,
          source: cit.source,
        });
      }
    }
  }

  // Second pass: Normalize each report
  for (const [id, report] of reports.entries()) {
    const localCitations = parseCitations(report);
    // Map of local index (1-based) to global ID
    const localToGlobal = new Map<number, number>();
    
    localCitations.forEach((cit, index) => {
      const globalId = urlToGlobalId.get(normalizeUrl(cit.url));
      if (globalId !== undefined) {
        // Key by the number the report actually WROTE for this entry (e.g. `[3]`), not its list
        // position. A report that numbers CITED LINKS non-sequentially (or has an entry dropped as
        // an implausible URL) would otherwise remap inline [N] to the wrong global id or leave it
        // dangling. Fall back to position when a written number is unavailable.
        const localKey = cit.number ?? (index + 1);
        localToGlobal.set(localKey, globalId);
      }
    });

    // Remove the trailing CITED LINKS section before renumbering — but only a real
    // line-leading, all-caps header, never an incidental "cited links" mention in
    // prose (an unanchored split there would drop real findings before the
    // evaluator ever sees them).
    const headerIdx = lastCitedLinksHeaderIndex(report);
    let content = headerIdx >= 0 ? report.slice(0, headerIdx) : report;

    // Renumber local [N] markers to their global ids, and DELETE the ones that could
    // not be mapped.
    //
    // Leaving an unmapped marker in place (the previous `return match`) was a silent
    // misattribution bug, not a harmless no-op: global ids are assigned densely from 1,
    // so a surviving `[1]` no longer means "this report's first source" — it resolves
    // against the renumbered global list and points at a completely different document.
    // Markers go unmapped whenever parseCitations dropped the entry (e.g. a URL whose
    // hostname has no dot: `localhost`, a bare internal host, a malformed line). The
    // result is fed straight into the evaluator/synthesis prompt, which is explicitly
    // told the numbering is already normalized — so the model faithfully reproduces the
    // wrong attribution, and ensureCitedLinks then regenerates a CITED LINKS list that
    // looks perfectly consistent with it.
    //
    // rewriteCitationMarkers is the same routine the synthesis path already uses: it
    // skips fenced blocks and inline code spans (so a quoted `items[12]` survives),
    // bounds what counts as a marker, and preserves line-leading indentation.
    content = rewriteCitationMarkers(
      content,
      localToGlobal,
      (n) => !localToGlobal.has(n),
    );

    normalizedReports.set(id, content.trim());
  }

  return { normalizedReports, globalCitations };
}

/**
 * Formats the global citation list into a CITED LINKS section string.
 */
export function formatCitedLinks(citations: GlobalCitation[]): string {
  if (citations.length === 0) return '';

  const links = citations.map(cit => {
    const sourcePart = cit.source ? ` [Source: ${cit.source}]` : '';
    const descPart = cit.description ? ` — ${cit.description}` : '';
    return `[${cit.id}] ${cit.url}${sourcePart}${descPart}`;
  });

  return `CITED LINKS\n${links.join('\n')}`;
}

/**
 * Largest `[N]` treated as a citation marker. Inline markers index a source list
 * that is realistically well under this; the bound exists so an ordinary bracketed
 * number in prose — a year (`[2023]`), an issue id, an array index — is left alone
 * instead of being silently deleted as a "dangling citation".
 */
export const MAX_PLAUSIBLE_CITATION_MARKER = 200;

/**
 * Rewrite inline `[N]` citation markers in a prose body: renumber the ones we can
 * map, delete the ones known to dangle, leave everything else untouched.
 *
 * Deletion is whitespace-aware rather than followed by a global space collapse.
 * A blanket `text.replace(/  +/g, ' ')` also eats *leading* indentation, which
 * silently flattens nested list levels into one and turns 4-space indented code
 * blocks into paragraphs — corrupting the structure of every report that contains
 * them. So the pad preceding a deleted marker is consumed only when the marker is
 * mid-line (i.e. real prose spacing); line-leading indentation is preserved.
 *
 * Code is skipped entirely. A report may quote code containing bracketed integers
 * (`items[12]`), and on the no-CITED-LINKS path *every* out-of-range marker is treated
 * as dangling — so without this guard a quoted array index would be silently deleted
 * from the user's code sample. Fenced blocks are tracked across lines; single-backtick
 * spans are detected by an odd backtick count earlier on the same line.
 *
 * @param remap  local marker number → verified global id
 * @param isDangling  whether a marker not present in `remap` should be deleted
 */
export function rewriteCitationMarkers(
  text: string,
  remap: Map<number, number>,
  isDangling: (n: number) => boolean,
): string {
  const inFence = fencedCodeMask(text);
  return text.replace(/([ \t]*)\[(\d+)\]/g, (match, pad: string, digits: string, offset: number) => {
    const n = parseInt(digits, 10);
    const mapped = remap.get(n);
    if (mapped !== undefined) return `${pad}[${mapped}]`;
    // Citation numbering is 1-based; `[0]` is always an index or a literal, never a marker.
    if (n < 1 || n > MAX_PLAUSIBLE_CITATION_MARKER || !isDangling(n)) return match;
    if (inFence(offset) || inInlineCodeSpan(text, offset)) return match;
    // Preserve indentation when nothing but whitespace precedes on this line;
    // otherwise drop the pad too so no double space is left behind.
    const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
    return text.slice(lineStart, offset).trim() === '' ? pad : '';
  });
}

/**
 * Build an `offset → is inside a ``` fenced block` predicate for `text`.
 *
 * Computed once per rewrite (a single line scan) rather than per marker, so marker
 * rewriting stays linear in the body length.
 */
function fencedCodeMask(text: string): (offset: number) => boolean {
  const ranges: Array<[number, number]> = [];
  let open = -1;
  let pos = 0;
  for (const line of text.split('\n')) {
    if (/^\s{0,3}(```|~~~)/.test(line)) {
      if (open < 0) open = pos;
      else {
        ranges.push([open, pos + line.length]);
        open = -1;
      }
    }
    pos += line.length + 1; // +1 for the '\n' consumed by split
  }
  // An unterminated fence runs to the end of the body — treat the remainder as code.
  if (open >= 0) ranges.push([open, text.length]);
  return (offset: number) => ranges.some(([start, end]) => offset >= start && offset < end);
}

/** Whether `offset` sits inside a single-backtick code span on its own line. */
function inInlineCodeSpan(text: string, offset: number): boolean {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  let ticks = 0;
  for (let i = lineStart; i < offset; i++) if (text[i] === '`') ticks++;
  return ticks % 2 === 1;
}
