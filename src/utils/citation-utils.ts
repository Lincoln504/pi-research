import { parseCitations, type Citation } from './text-utils.ts';
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
export function normalizeCitations(reports: Map<string, string>): {
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
        localToGlobal.set(index + 1, globalId);
      }
    });

    // Remove the CITED LINKS section
    const parts = report.split(/CITED LINKS\b/i);
    let content = parts[0] || '';

    // Replace [N] with [GlobalID]
    // Also handle [N][M] combinations
    content = content.replace(/\[(\d+)\]/g, (match, p1) => {
      const localId = parseInt(p1, 10);
      const globalId = localToGlobal.get(localId);
      return globalId !== undefined ? `[${globalId}]` : match;
    });

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
