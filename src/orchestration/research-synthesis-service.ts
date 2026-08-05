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
import { normalizeCitations, formatCitedLinks, rewriteCitationMarkers, type GlobalCitation } from '../utils/citation-utils.ts';
import { lastCitedLinksHeaderIndex } from '../utils/text-utils.ts';
import { getScrapedLinks, isTranscribedLink, normalizeUrl } from '../utils/shared-links.ts';
import { stripTrailingLlmPunctuation } from '../utils/url-utils.ts';
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

// Appended when the model wrote its own links but the run retrieved nothing we could
// verify them against. The block is kept (it may still be a useful lead) but must not
// read as though the engine checked it.
const UNVERIFIED_LINKS_NOTE =
  '_None of the links above could be verified: no page fetch succeeded this session and no citation could be matched to retrieved content. They may be inaccurate or invented — check each one before relying on it._';


/**
 * Redact inline `https?://` tokens in synthesis prose whose URL was NOT retrieved
 * this session (absent from `trusted`, a set of normalized verified-source URLs).
 *
 * The synthesis body is otherwise passed through verbatim, so an unverified inline
 * URL is the one channel by which a fabricated source can reach the user — and
 * inline URLs violate the required format (links belong in CITED LINKS only).
 * Legitimate inline references to real sources are preserved (they are present in
 * `trusted`). Returns the (possibly) redacted text.
 */
function redactUnverifiedProseUrls(text: string, trusted: Set<string>): string {
  if (trusted.size === 0) return text;
  let removed = 0;
  // Brackets are NOT excluded from the token: a bare `[^\s)\]>"']+` truncates
  // `.../Python_(programming_language)` at the first `)`, so the truncated form
  // never matches its own entry in `trusted` and a perfectly good Wikipedia link
  // gets redacted. Instead take the greedy token and split off exactly the
  // trailing punctuation `normalizeUrl` itself discards — so the compared string
  // and the redacted span always agree — restoring that tail afterwards.
  const result = text.replace(/https?:\/\/[^\s<>"']+/gi, (token) => {
    const core = stripTrailingLlmPunctuation(token);
    const tail = token.slice(core.length);
    if (!core || trusted.has(normalizeUrl(core))) return token;
    removed++;
    return `[link removed: not found in retrieved sources]${tail}`;
  });
  if (removed > 0) {
    logger.warn(`[ResearchSynthesisService] Redacted ${removed} unverified inline URL(s) from synthesis prose (not present in retrieved sources).`);
  }
  return result;
}

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
   * Read a session's reports WITHOUT creating an entry for an unknown id.
   *
   * The read-only accessors below must not go through `getSessionReports`: that
   * is create-on-read, so a query for an id we have never seen inserts an empty
   * map — and at MAX_SESSIONS that insert evicts the current head. The LRU touch
   * protects sessions that are read or written, but an in-flight run whose
   * researchers are all still executing (reports stored early, nothing touched
   * since) is exactly the stalest key, so a stray read for an unknown session
   * could evict a live run's reports and silently shrink its final synthesis.
   *
   * Returns a shared empty map for unknown ids — callers here only read.
   */
  private peekSessionReports(sessionId: string): ReadonlyMap<string, string> {
    return this.sessions.get(sessionId) ?? ResearchSynthesisService.EMPTY_REPORTS;
  }

  private static readonly EMPTY_REPORTS: ReadonlyMap<string, string> = new Map<string, string>();

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
    return this.peekSessionReports(sessionId).get(id);
  }

  /**
   * Get all reports
   */
  getAllReports(sessionId: string): Map<string, string> {
    return new Map(this.peekSessionReports(sessionId));
  }

  /**
   * Get reports for a specific round
   */
  getReportsForRound(sessionId: string, round: number): Map<string, string> {
    const roundReports = new Map<string, string>();
    const prefix = `${round}.`;
    for (const [key, report] of this.peekSessionReports(sessionId).entries()) {
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
    return this.peekSessionReports(sessionId).size;
  }

  /**
   * Check if there are any reports
   */
  hasReports(sessionId: string): boolean {
    return this.peekSessionReports(sessionId).size > 0;
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
    const reports = this.peekSessionReports(sessionId);
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
    const reports = this.peekSessionReports(sessionId);

    // Primary source: citations the researchers wrote into their reports. These are
    // the richest (they carry descriptions and source tags), so they win when present.
    let globalCitations: GlobalCitation[] =
      reports.size > 0 ? normalizeCitations(reports).globalCitations : [];

    // NOTE: a "provenance gate" previously DROPPED citations tagged Scrape/Transcript
    // whose URL was absent from the session's successful-scrape pool. It was REMOVED
    // because it conflated a failed/blocked scrape (real URL, content unretrieved) with
    // fabrication: under the common high scrape-failure rate (bot blocks on GitHub /
    // Microsoft / etc.) it mass-dropped legitimate citations, and the remap below then
    // neutralized their inline [N] markers into a broken '[removed]' token that reached
    // users. We now KEEP every parsed citation (deduped by URL) and never emit
    // '[removed]'; a dangling inline marker is removed cleanly instead. Fabrication
    // defense rests on the URL dedup + the prose-URL sweep, which do not punish failed
    // scrapes. (The successful-scrape pool is still reconciled below to FOLD IN any
    // sources the researchers scraped but failed to cite.)

    // Robustness fallback: reconcile against ground-truth provenance — the URLs
    // ACTUALLY, successfully scraped this session (registerScrapedLinks only records
    // HTTP-success fetches). This runs even when SOME citations parsed: a
    // multi-researcher run where only one researcher's report has an unparseable/
    // missing "CITED LINKS" block still needs that researcher's real sources folded
    // in — gating this on globalCitations being entirely EMPTY only ever caught the
    // all-researchers-failed-to-cite case and silently dropped a partial researcher's
    // sources whenever ANY other researcher cited normally. Only URLs not already
    // represented (by normalized URL) are added, so parsed citations — richer, with
    // descriptions and source tags — are never overwritten.
    if (reports.size > 0) {
      const scraped = getScrapedLinks(sessionId);
      if (scraped.length > 0) {
        const known = new Set(globalCitations.map((c) => normalizeUrl(c.url)));
        const missing = scraped.filter((url) => !known.has(normalizeUrl(url)));
        if (missing.length > 0) {
          const startId = globalCitations.reduce((max, c) => Math.max(max, c.id), 0) + 1;
          // Label per actual provenance: the pool also contains transcript watch
          // URLs the youtube_transcript tool registered — calling those "Scrape"
          // misattributes the report's real source material.
          globalCitations = [
            ...globalCitations,
            ...missing.map((url, i) => ({
              id: startId + i,
              url,
              description: '',
              source: isTranscribedLink(sessionId, url) ? 'YouTube Transcript' : 'Scrape',
            })),
          ];
          logger.warn(
            `[ResearchSynthesisService] Folded in ${missing.length} source(s) from scrape/transcript provenance not covered by parsed citations.`,
          );
        }
      }
    }

    if (globalCitations.length > 0) {
      const verifiedLinksSection = formatCitedLinks(globalCitations);
      const trustedUrls = new Set(globalCitations.map((c) => normalizeUrl(c.url)));
      // Replace an existing CITED LINKS section with the verified version — but only
      // a line-leading, all-caps "CITED LINKS" header marks the section. An
      // unanchored /CITED LINKS[\s\S]*$/i would also fire on an incidental
      // "...the cited links below..." in prose and truncate the entire report body
      // from that point (silent content loss). Anchor to the LAST header line.
      const citedHeaderIdx = lastCitedLinksHeaderIndex(synthesis);
      if (citedHeaderIdx >= 0) {
        logger.debug('[ResearchSynthesisService] Replacing existing CITED LINKS with verified version');
        // The verified list is renumbered (dedup by URL, implausible entries dropped),
        // but the body's inline [N] markers were authored against the list being replaced.
        // Remap them by URL identity — parse the synthesis's own list and map each
        // written number to the global id of the same normalized URL. In deep mode
        // the numbering already matches and this is a no-op; in quick mode (where the
        // model's own list is what gets replaced) it prevents every marker after a
        // dropped/deduped entry from pointing at the wrong source.
        const ownCitations = parseCitations(synthesis);
        const urlToGlobalId = new Map(globalCitations.map((c) => [normalizeUrl(c.url), c.id]));
        const localToGlobal = new Map<number, number>();
        // own-citation numbers whose URL is absent from the verified list. Their inline
        // [N] markers are REMOVED cleanly (never '[removed]') so the prose reads
        // naturally. A marker can dangle only if the lead cited a URL absent from the
        // rebuilt list (e.g. it invented one not in any researcher report); removing it
        // beats shipping a broken token or silently retargeting it at the wrong source.
        const droppedNumbers = new Set<number>();
        ownCitations.forEach((cit, index) => {
          const localKey = cit.number ?? index + 1;
          const globalId = urlToGlobalId.get(normalizeUrl(cit.url));
          if (globalId !== undefined) localToGlobal.set(localKey, globalId);
          else droppedNumbers.add(localKey);
        });
        let body = synthesis.slice(0, citedHeaderIdx).trimEnd();
        if (localToGlobal.size > 0 || droppedNumbers.size > 0) {
          body = rewriteCitationMarkers(body, localToGlobal, (n) => droppedNumbers.has(n));
        }
        // Defense-in-depth: redact unverified inline URLs in the prose body. The body
        // is otherwise passed through verbatim, so this is the one channel by which a
        // fabricated source can still reach the user; inline URLs also violate the
        // required format. Verified inline references (in `trustedUrls`) are kept.
        body = redactUnverifiedProseUrls(body, trustedUrls);
        return `${body}\n\n${verifiedLinksSection}`;
      }
      logger.warn('[ResearchSynthesisService] Synthesis missing CITED LINKS - appending verified version');
      // No existing CITED LINKS header: the synthesis is all prose. The model's
      // inline [N] markers were authored without a list we could remap against, so
      // REMOVE any that fall outside the verified range (1..K) — they point at sources
      // absent from the rebuilt list — before sweeping for unverified inline URLs and
      // appending the verified section. Removed cleanly (never '[removed]').
      const validIds = new Set(globalCitations.map((c) => c.id));
      let prose = rewriteCitationMarkers(synthesis.trim(), new Map(), (n) => !validIds.has(n));
      prose = redactUnverifiedProseUrls(prose, trustedUrls);
      return `${prose}\n\n${verifiedLinksSection}`;
    }

    // Genuinely no sources were retrieved (e.g. every search/scrape was blocked by
    // bot protection, or none returned usable content). Never silently ship an
    // uncited report that looks sourced — but also never destroy a CITED LINKS block
    // the model may have written that we simply could not parse (preserve as-is).
    if (/CITED LINKS/i.test(synthesis)) {
      // Preserved, but NOT silently: reaching here means no citation parsed AND no
      // scrape succeeded, so every link in that block is unverified by construction.
      // Returning it untouched shipped a fully sourced-looking report with no caveat —
      // the worst case for a reader, since an unretrievable session is precisely when
      // a model's links are most likely to be invented.
      logger.warn('[ResearchSynthesisService] Preserving an unparseable CITED LINKS block from a run that retrieved no sources — flagging it as unverified.');
      return `${synthesis.trimEnd()}\n\n${UNVERIFIED_LINKS_NOTE}`;
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
    const reports = this.peekSessionReports(sessionId);

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