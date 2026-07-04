/**
 * Research Synthesis Service
 *
 * Responsible for aggregating researcher reports and building the final synthesis.
 * Handles:
 * - Report collection and storage
 * - Fallback synthesis building
 * - Citation extraction and management
 * - Ensuring CITED LINKS section in output
 */

import { parseCitations } from '../utils/text-utils.ts';
import { normalizeCitations, formatCitedLinks, type GlobalCitation } from '../utils/citation-utils.ts';
import { lastCitedLinksHeaderIndex } from '../utils/text-utils.ts';
import { getScrapedLinks, normalizeUrl } from '../utils/shared-links.ts';
import { logger } from '../logger.ts';
import { ServiceLifecycle, type IService } from '../core/service-registry.ts';
import { ServiceNames } from '../core/interfaces/service-names.ts';
import type { SteeringMessage } from './session-state.ts';

// Shown in place of a sources list when a run retrieved no citable web sources at
// all (no parseable citations AND no successfully-scraped URLs). Keeping the
// "CITED LINKS" header means downstream consumers and the user always find the
// section in its usual place; the italic note makes the empty result explicit
// rather than letting an uncited report read as if it were sourced.
const NO_SOURCES_NOTE =
  'CITED LINKS\n_No web sources were successfully retrieved for this report — searches or page fetches may have been blocked (for example by site bot-protection) or returned no usable results. Treat the findings above as unverified._';

/**
 * Research Synthesis Service
 *
 * Aggregates researcher reports and builds final synthesis.
 */
export class ResearchSynthesisService implements IService {
  readonly name = ServiceNames.RESEARCH_SYNTHESIS_SERVICE;
  lifecycle = ServiceLifecycle.UNINITIALIZED;

  // Map of sessionId -> Map<reportId, reportContent>
  private sessions = new Map<string, Map<string, string>>();
  // Cap to prevent unbounded growth from orphaned sessions during long-lived Pi
  // sessions. Generous because each session map is small and the normal path clears
  // reports via cleanupResearchServices on run completion — this is only a backstop
  // for runs that never cleaned up (e.g. crashes).
  private static readonly MAX_SESSIONS = 200;

  private getSessionReports(sessionId: string): Map<string, string> {
    let reports = this.sessions.get(sessionId);
    if (reports) {
      // LRU touch: re-insert to move to the end so an actively-written session is
      // never the eviction victim below (Map preserves insertion order).
      this.sessions.delete(sessionId);
      this.sessions.set(sessionId, reports);
      return reports;
    }
    // Evict the least-recently-used session when at capacity. Because every
    // store/read touches its session to the end (above), the head is the genuinely
    // stalest session, not merely the first-created — so an in-flight run is spared.
    if (this.sessions.size >= ResearchSynthesisService.MAX_SESSIONS) {
      const oldestKey = this.sessions.keys().next().value;
      if (oldestKey !== undefined) {
        logger.warn(`[ResearchSynthesisService] Session limit (${ResearchSynthesisService.MAX_SESSIONS}) reached, evicting least-recently-used: ${oldestKey}`);
        this.sessions.delete(oldestKey);
      }
    }
    reports = new Map<string, string>();
    this.sessions.set(sessionId, reports);
    return reports;
  }

  /**
   * Store a researcher report
   * @param sessionId - Session identifier
   * @param id - Report identifier (typically "round.researcherId")
   * @param report - The researcher's report content
   */
  storeReport(sessionId: string, id: string, report: string): void {
    this.getSessionReports(sessionId).set(id, report);
  }

  /**
   * Get a report by ID
   */
  getReport(sessionId: string, id: string): string | undefined {
    return this.getSessionReports(sessionId).get(id);
  }

  /**
   * Get all reports
   */
  getAllReports(sessionId: string): Map<string, string> {
    return new Map(this.getSessionReports(sessionId));
  }

  /**
   * Get reports for a specific round
   */
  getReportsForRound(sessionId: string, round: number): Map<string, string> {
    const roundReports = new Map<string, string>();
    const prefix = `${round}.`;
    for (const [key, report] of this.getSessionReports(sessionId).entries()) {
      if (key.startsWith(prefix)) {
        roundReports.set(key, report);
      }
    }
    return roundReports;
  }

  /**
   * Get total number of reports
   */
  getReportCount(sessionId: string): number {
    return this.getSessionReports(sessionId).size;
  }

  /**
   * Check if there are any reports
   */
  hasReports(sessionId: string): boolean {
    return this.getSessionReports(sessionId).size > 0;
  }

  /**
   * Clear reports for a session, or all reports if no sessionId provided
   */
  clearReports(sessionId?: string): void {
    if (sessionId) {
      this.sessions.delete(sessionId);
    } else {
      this.sessions.clear();
    }
  }

  /**
   * Build fallback synthesis from collected reports
   * @param sessionId - Session identifier
   * @param currentRound - Current research round number
   * @returns Fallback synthesis string
   */
  buildFallbackSynthesis(sessionId: string, currentRound: number = 0): string {
    const reports = this.getSessionReports(sessionId);
    const reportCount = reports.size;
    const roundInfo = currentRound > 0 ? ` (up to Round ${currentRound})` : '';
    let synthesis = `Research Findings${roundInfo}\n\n`;

    if (reportCount === 0) {
      synthesis += 'No researcher reports were generated before the process stopped.';
    } else {
      synthesis += `This is an automated synthesis of ${reportCount} individual researcher report(s) gathered before the process was interrupted.\n\n`;
      synthesis += Array.from(reports.entries())
        .map(([id, report]) => `Researcher ${id}\n\n${report}`)
        .join('\n\n');
    }

    return synthesis;
  }

  /**
   * Append research metadata (model used) to the end of the synthesis
   */
  appendMetadata(synthesis: string, modelId: string): string {
    return `${synthesis.trim()}\n\nResearch performed using ${modelId}`;
  }

  /**
   * Ensure the synthesis has an accurate and consistent CITED LINKS section.
   * Rebuilds the section from all researcher reports to guarantee sequential numbering [1], [2], [3]...
   * and unique URLs, regardless of what the LLM produced.
   * 
   * @param sessionId - Session identifier
   * @param synthesis - The synthesis text to check and potentially augment
   * @returns Synthesis with guaranteed and verified CITED LINKS section
   */
  ensureCitedLinks(sessionId: string, synthesis: string): string {
    const reports = this.getSessionReports(sessionId);

    // Primary source: citations the researchers wrote into their reports. These are
    // the richest (they carry descriptions and source tags), so they win when present.
    let globalCitations: GlobalCitation[] =
      reports.size > 0 ? normalizeCitations(reports).globalCitations : [];

    // Robustness fallback: if the reports yielded no parseable citations — e.g. the
    // LLM omitted or mangled its "CITED LINKS" block, or wrote the sources under a
    // heading parseCitations does not recognize — rebuild the sources list from the
    // ground-truth provenance: the URLs the researchers ACTUALLY, successfully
    // scraped this session (registerScrapedLinks only records HTTP-success fetches).
    // This decouples the final sources list from fragile LLM prose formatting so that
    // real fetched sources are never silently lost.
    if (globalCitations.length === 0) {
      const scraped = getScrapedLinks(sessionId);
      if (scraped.length > 0) {
        globalCitations = scraped.map((url, i) => ({ id: i + 1, url, description: '', source: 'Scrape' }));
        logger.warn(
          `[ResearchSynthesisService] No citations parsed from reports; rebuilt ${scraped.length} source(s) from scrape provenance.`,
        );
      }
    }

    if (globalCitations.length > 0) {
      const verifiedLinksSection = formatCitedLinks(globalCitations);
      // Replace an existing CITED LINKS section with the verified version — but only
      // a line-leading, all-caps "CITED LINKS" header marks the section. An
      // unanchored /CITED LINKS[\s\S]*$/i would also fire on an incidental
      // "...the cited links below..." in prose and truncate the entire report body
      // from that point (silent content loss). Anchor to the LAST header line.
      const citedHeaderIdx = lastCitedLinksHeaderIndex(synthesis);
      if (citedHeaderIdx >= 0) {
        logger.debug('[ResearchSynthesisService] Replacing existing CITED LINKS with verified version');
        // The verified list is renumbered (dedup by URL, implausible entries dropped),
        // but the body's inline [N] markers were authored against the list being
        // replaced. Remap them by URL identity — parse the synthesis's own list and
        // map each written number to the global id of the same normalized URL. In
        // deep mode the numbering already matches and this is a no-op; in quick mode
        // (where the model's own list is what gets replaced) it prevents every
        // marker after a dropped/deduped entry from pointing at the wrong source.
        const ownCitations = parseCitations(synthesis);
        const urlToGlobalId = new Map(globalCitations.map((c) => [normalizeUrl(c.url), c.id]));
        const localToGlobal = new Map<number, number>();
        ownCitations.forEach((cit, index) => {
          const globalId = urlToGlobalId.get(normalizeUrl(cit.url));
          if (globalId !== undefined) localToGlobal.set(cit.number ?? index + 1, globalId);
        });
        let body = synthesis.slice(0, citedHeaderIdx).trimEnd();
        const needsRemap = [...localToGlobal].some(([local, global]) => local !== global);
        if (needsRemap) {
          body = body.replace(/\[(\d+)\]/g, (match, p1) => {
            const globalId = localToGlobal.get(parseInt(p1, 10));
            return globalId !== undefined ? `[${globalId}]` : match;
          });
        }
        return `${body}\n\n${verifiedLinksSection}`;
      }
      logger.warn('[ResearchSynthesisService] Synthesis missing CITED LINKS - appending verified version');
      return `${synthesis.trim()}\n\n${verifiedLinksSection}`;
    }

    // Genuinely no sources were retrieved (e.g. every search/scrape was blocked by
    // bot protection, or none returned usable content). Never silently ship an
    // uncited report that looks sourced — but also never destroy a CITED LINKS block
    // the model may have written that we simply could not parse (preserve as-is).
    if (/CITED LINKS/i.test(synthesis)) {
      return synthesis;
    }
    logger.warn('[ResearchSynthesisService] No citations and no scrape provenance — appending explicit no-sources note.');
    return `${synthesis.trim()}\n\n${NO_SOURCES_NOTE}`;
  }

  /**
   * Append steering guidance to the end of the synthesis.
   * Only active (consumed-by-orchestrator) steering messages are included;
   * queued and popped messages are excluded.
   *
   * @param synthesis - The synthesis text
   * @param steeringMessages - Steering messages captured for the session
   * @returns Synthesis with steering guidance appended
   */
  appendSteeringGuidance(synthesis: string, steeringMessages: SteeringMessage[]): string {
    const texts = (steeringMessages ?? [])
      .filter(m => m.status === 'active')
      .map(m => m.text);

    if (texts.length === 0) {
      return synthesis;
    }

    const guidanceSection = [
      'The following guidance was provided by the user during the research process and influenced these results:',
      '',
      ...texts,
    ].join('\n');

    return `${synthesis.trim()}\n\n${guidanceSection}`;
  }

  /**
   * Extract all citations from all reports
   * @param sessionId - Session identifier
   * @returns Array of unique citations across all reports
   */
  extractAllCitations(sessionId: string): Array<{ url: string; description: string; source?: string }> {
    const seen = new Set<string>();
    const allCitations: Array<{ url: string; description: string; source?: string }> = [];
    const reports = this.getSessionReports(sessionId);

    for (const report of reports.values()) {
      const citations = parseCitations(report);
      for (const cit of citations) {
        if (!seen.has(cit.url)) {
          seen.add(cit.url);
          allCitations.push(cit);
        }
      }
    }

    return allCitations;
  }

  /**
   * Get citations for a specific round
   * @param sessionId - Session identifier
   * @param round - Round number
   * @returns Array of citations from reports in the specified round
   */
  extractCitationsForRound(sessionId: string, round: number): Array<{ url: string; description: string; source?: string }> {
    const seen = new Set<string>();
    const citations: Array<{ url: string; description: string; source?: string }> = [];
    const roundReports = this.getReportsForRound(sessionId, round);

    for (const report of roundReports.values()) {
      const parsedCitations = parseCitations(report);
      for (const cit of parsedCitations) {
        if (!seen.has(cit.url)) {
          seen.add(cit.url);
          citations.push(cit);
        }
      }
    }

    return citations;
  }

  /**
   * Reset service state
   */
  reset(): void {
    this.sessions.clear();
  }

  async initialize(): Promise<void> {
    if (this.lifecycle === ServiceLifecycle.INITIALIZED) {
      return;
    }
    this.lifecycle = ServiceLifecycle.INITIALIZING;
    logger.debug('[ResearchSynthesisService] Initializing...');
    this.lifecycle = ServiceLifecycle.INITIALIZED;
    logger.debug('[ResearchSynthesisService] Initialized');
  }

  async dispose(): Promise<void> {
    if (this.lifecycle === ServiceLifecycle.DISPOSED) {
      return;
    }
    this.lifecycle = ServiceLifecycle.DISPOSING;
    logger.debug('[ResearchSynthesisService] Disposing...');
    this.sessions.clear();
    this.lifecycle = ServiceLifecycle.DISPOSED;
    logger.debug('[ResearchSynthesisService] Disposed');
  }
}