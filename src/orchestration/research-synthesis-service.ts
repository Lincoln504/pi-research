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
import { normalizeCitations, formatCitedLinks } from '../utils/citation-utils.ts';
import { logger } from '../logger.ts';
import { ServiceLifecycle, type IService } from '../core/service-registry.ts';
import { ServiceNames } from '../core/interfaces/service-names.ts';
import type { SteeringMessage } from './session/session-state.ts';

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
  // FIX (New Issue D): Maximum number of sessions to prevent unbounded growth
  // from orphaned sessions during long-lived Pi sessions.
  private static readonly MAX_SESSIONS = 50;

  private getSessionReports(sessionId: string): Map<string, string> {
    let reports = this.sessions.get(sessionId);
    if (!reports) {
      // FIX (New Issue D): Evict the oldest session when at capacity
      if (this.sessions.size >= ResearchSynthesisService.MAX_SESSIONS) {
        const oldestKey = this.sessions.keys().next().value;
        if (oldestKey !== undefined) {
          logger.warn(`[ResearchSynthesisService] Session limit (${ResearchSynthesisService.MAX_SESSIONS}) reached, evicting oldest: ${oldestKey}`);
          this.sessions.delete(oldestKey);
        }
      }
      reports = new Map<string, string>();
      this.sessions.set(sessionId, reports);
    }
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
    if (reports.size === 0) return synthesis;

    // Use the same normalization logic as the planning service
    const { globalCitations } = normalizeCitations(reports);
    if (globalCitations.length === 0) return synthesis;

    const verifiedLinksSection = formatCitedLinks(globalCitations);

    // If the synthesis already has a CITED LINKS section, replace it with the verified version
    if (/CITED LINKS/i.test(synthesis)) {
      logger.debug('[ResearchSynthesisService] Replacing existing CITED LINKS with verified version');
      return synthesis.replace(/CITED LINKS[\s\S]*$/i, verifiedLinksSection);
    }

    logger.warn('[ResearchSynthesisService] Synthesis missing CITED LINKS - appending verified version');
    return `${synthesis.trim()}\n\n${verifiedLinksSection}`;
  }

  /**
   * Append steering guidance to the end of the synthesis
   * 
   * Accepts either string[] (backward compat) or SteeringMessage[] (new).
   * When SteeringMessage[] is passed, only active (consumed) messages are included.
   * When string[] is passed, all are included (legacy behavior for SDK).
   * 
   * @param synthesis - The synthesis text
   * @param steeringMessages - Array of steering messages (strings or SteeringMessage objects)
   * @returns Synthesis with steering guidance appended
   */
  appendSteeringGuidance(synthesis: string, steeringMessages: string[] | SteeringMessage[]): string {
    // Extract text from SteeringMessage[] or use string[] directly
    let texts: string[];
    if (steeringMessages && steeringMessages.length > 0) {
      const first = steeringMessages[0];
      if (typeof first === 'object' && 'text' in first && 'status' in first) {
        // SteeringMessage[] — only include active (consumed by orchestrator) messages
        texts = (steeringMessages as SteeringMessage[])
          .filter(m => m.status === 'active')
          .map(m => m.text);
      } else {
        // string[] — legacy/SDK path, include all
        texts = steeringMessages as string[];
      }
    } else {
      texts = [];
    }

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