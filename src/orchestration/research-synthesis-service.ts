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
import { logger } from '../logger.ts';
import { ServiceLifecycle, type IService } from '../core/service-registry.ts';

/**
 * Research Synthesis Service
 *
 * Aggregates researcher reports and builds final synthesis.
 */
export class ResearchSynthesisService implements IService {
  readonly name = 'research-synthesis-service';
  lifecycle = ServiceLifecycle.UNINITIALIZED;

  private reports = new Map<string, string>();

  /**
   * Store a researcher report
   * @param id - Report identifier (typically "round.researcherId")
   * @param report - The researcher's report content
   */
  storeReport(id: string, report: string): void {
    this.reports.set(id, report);
  }

  /**
   * Get a report by ID
   */
  getReport(id: string): string | undefined {
    return this.reports.get(id);
  }

  /**
   * Get all reports
   */
  getAllReports(): Map<string, string> {
    return new Map(this.reports);
  }

  /**
   * Get reports for a specific round
   */
  getReportsForRound(round: number): Map<string, string> {
    const roundReports = new Map<string, string>();
    const prefix = `${round}.`;
    for (const [key, report] of this.reports.entries()) {
      if (key.startsWith(prefix)) {
        roundReports.set(key, report);
      }
    }
    return roundReports;
  }

  /**
   * Get total number of reports
   */
  getReportCount(): number {
    return this.reports.size;
  }

  /**
   * Check if there are any reports
   */
  hasReports(): boolean {
    return this.reports.size > 0;
  }

  /**
   * Clear all reports
   */
  clearReports(): void {
    this.reports.clear();
  }

  /**
   * Build fallback synthesis from collected reports
   * @param currentRound - Current research round number
   * @returns Fallback synthesis string
   */
  buildFallbackSynthesis(currentRound: number = 0): string {
    const reportCount = this.reports.size;
    const roundInfo = currentRound > 0 ? ` (up to Round ${currentRound})` : '';
    let synthesis = `# Research Findings${roundInfo}\n\n`;

    if (reportCount === 0) {
      synthesis += '_No researcher reports were generated before the process stopped._';
    } else {
      synthesis += `*This is an automated synthesis of ${reportCount} individual researcher report(s) gathered before the process was interrupted.*\n\n`;
      synthesis += Array.from(this.reports.entries())
        .map(([id, report]) => `## Researcher ${id}\n\n${report}`)
        .join('\n\n---\n\n');
    }

    return synthesis;
  }

  /**
   * Ensure the synthesis has a ### CITED LINKS section.
   * If missing, extract all URLs from researcher reports and append them.
   * @param synthesis - The synthesis text to check and potentially augment
   * @returns Synthesis with guaranteed CITED LINKS section
   */
  ensureCitedLinks(synthesis: string): string {
    if (/###\s*CITED LINKS/i.test(synthesis)) return synthesis;

    logger.warn('[ResearchSynthesisService] Synthesis missing CITED LINKS - rebuilding from researcher reports');

    // Parse each researcher report's CITED LINKS section and collect unique URLs
    const seen = new Set<string>();
    const links: { url: string; desc: string; source?: string }[] = [];

    for (const report of this.reports.values()) {
      const citations = parseCitations(report);
      for (const cit of citations) {
        if (!seen.has(cit.url)) {
          seen.add(cit.url);
          links.push({ url: cit.url, desc: cit.description, source: cit.source });
        }
      }
    }

    if (links.length === 0) return synthesis;

    const linksSection = links
      .map(({ url, desc, source }, i) => {
        const sourcePart = source ? ` [Source: ${source}]` : '';
        return `[${i + 1}] ${url}${sourcePart}${desc ? ` - ${desc}` : ''}`;
      })
      .join('\n');

    return `${synthesis}\n\n### CITED LINKS\n${linksSection}`;
  }

  /**
   * Extract all citations from all reports
   * @returns Array of unique citations across all reports
   */
  extractAllCitations(): Array<{ url: string; description: string; source?: string }> {
    const seen = new Set<string>();
    const allCitations: Array<{ url: string; description: string; source?: string }> = [];

    for (const report of this.reports.values()) {
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
   * @param round - Round number
   * @returns Array of citations from reports in the specified round
   */
  extractCitationsForRound(round: number): Array<{ url: string; description: string; source?: string }> {
    const seen = new Set<string>();
    const citations: Array<{ url: string; description: string; source?: string }> = [];
    const roundReports = this.getReportsForRound(round);

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
    this.reports.clear();
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
    this.reports.clear();
    this.lifecycle = ServiceLifecycle.DISPOSED;
    logger.debug('[ResearchSynthesisService] Disposed');
  }
}