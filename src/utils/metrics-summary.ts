/**
 * Shared metrics summary formatting.
 *
 * Used by BOTH:
 * - The final research result (appendResearchSummary in research-tool-definition.ts)
 * - The session metrics view (showMetricsAction in research-config.ts)
 *
 * This ensures a consistent structure between the two views:
 *   - Plain lists, no tables
 *   - Counts only, no percentages
 *   - Human-friendly labels, never raw Prometheus-style metric names
 *   - Subtly impressive: emphasizes volume of work done (sources analyzed,
 *     links discovered, pages scraped, etc.)
 */

import { formatTimeAgo, formatDuration } from './text-utils.js';
import type { IMetricsSnapshot } from './metrics.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResearchStats {
  /** Total research duration in milliseconds. */
  durationMs: number;
  /** Complexity level: 0 (quick), 1, 2, or 3. */
  complexity: number;
  /** Number of researchers that were launched. */
  researchersLaunched: number;
  /** Number of rounds completed. */
  roundsCompleted: number;
  /** Number of search queries submitted. */
  searchQueries: number;
  /** Number of unique URLs discovered via search. */
  urlsDiscovered: number;
  /** Number of URLs successfully scraped/analyzed. */
  urlsAnalyzed: number;
  /** Number of URLs that failed to scrape. */
  urlsFailed: number;
  /** Total errors encountered during the run. */
  errors: number;
  /** Total LLM tokens consumed. */
  tokens: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract a clean numeric value from a metrics snapshot counter map.
 * Sums all label-variants of the given counter base name.
 *
 * Example: sumCounter(snapshot.counters, 'scrape_results_total')
 *   sums scrape_results_total{outcome="fetch_success"} + ...browser_success + ...total_failure
 */
export function sumCounter(
  counters: Record<string, number>,
  baseName: string
): number {
  let total = 0;
  for (const [key, value] of Object.entries(counters)) {
    // Match exact name or name followed by `{labels}`
    if (key === baseName || key.startsWith(baseName + '{')) {
      total += value;
    }
  }
  return total;
}

/**
 * Extract a specific labeled counter value.
 *
 * Example: getLabeledCounter(counters, 'scrape_results_total', { outcome: 'fetch_success' })
 */
export function getLabeledCounter(
  counters: Record<string, number>,
  baseName: string,
  labels: Record<string, string>
): number {
  // Build the label suffix to match: {key1="val1",key2="val2"}
  const labelParts = Object.entries(labels).map(([k, v]) => `${k}="${v}"`);
  const suffix = `{${labelParts.join(',')}}`;

  // Also try without the base name prefix repetition
  for (const [key, value] of Object.entries(counters)) {
    if (key === `${baseName}${suffix}`) {
      return value;
    }
  }
  return 0;
}

/**
 * Sum all label-variants of a counter matching a specific label filter.
 *
 * Example: sumLabeledCounter(counters, 'search_queries_total', { status: 'success' })
 */
export function sumLabeledCounter(
  counters: Record<string, number>,
  baseName: string,
  labelFilter: Partial<Record<string, string>>
): number {
  let total = 0;
  for (const [key, value] of Object.entries(counters)) {
    if (!key.startsWith(baseName + '{') && key !== baseName) continue;
    if (Object.keys(labelFilter).length === 0) {
      total += value;
      continue;
    }
    // Check if all filter labels match
    let allMatch = true;
    for (const [filterKey, filterVal] of Object.entries(labelFilter)) {
      if (!key.includes(`${filterKey}="${filterVal}"`)) {
        allMatch = false;
        break;
      }
    }
    if (allMatch) total += value;
  }
  return total;
}

// formatDuration and formatTimeAgo are imported from text-utils.ts

/**
 * Format a token count with thousands separators (e.g., "12,345").
 */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  return tokens.toLocaleString('en-US');
}

// ---------------------------------------------------------------------------
// Run stats extraction from snapshot
// ---------------------------------------------------------------------------

/**
 * Extract human-relevant research stats from a run metrics snapshot.
 * Returns null if the snapshot has no meaningful data.
 */
export function extractRunStats(snapshot: IMetricsSnapshot): ResearchStats | null {
  const counters = snapshot.counters || {};
  const histograms = snapshot.histograms || {};

  // Researchers launched
  const researchersLaunched = sumCounter(counters, 'researchers_launched_total');

  // Search queries — combine browser search and regular search
  const browserSearchQueries = sumCounter(counters, 'browser_search_queries_total');
  const searchQueries = sumCounter(counters, 'search_queries_total') + browserSearchQueries;

  // URLs discovered via search
  const urlsDiscovered = sumCounter(counters, 'browser_search_results_total') +
    sumCounter(counters, 'browser_search_unique_urls_total');

  // URLs scraped — outcomes from scrape_results_total
  const fetchSuccess = getLabeledCounter(counters, 'scrape_results_total', { outcome: 'fetch_success' });
  const browserSuccess = getLabeledCounter(counters, 'scrape_results_total', { outcome: 'browser_success' });
  const totalFailure = getLabeledCounter(counters, 'scrape_results_total', { outcome: 'total_failure' });
  const urlsAnalyzed = fetchSuccess + browserSuccess;
  const urlsFailed = totalFailure;

  // Errors
  const errors = sumCounter(counters, 'scrape_errors_total') +
    sumCounter(counters, 'researcher_errors_total') +
    sumCounter(counters, 'llm_api_errors_total');

  // Tokens — sum all label variants
  const tokens = sumCounter(counters, 'llm_tokens_total');

  // Duration from histogram
  const durationMs = histograms['research_session_duration_ms{mode="deep",complexity="1",status="success"}']?.max ||
    histograms['research_session_duration_ms{mode="deep",complexity="2",status="success"}']?.max ||
    histograms['research_session_duration_ms{mode="deep",complexity="3",status="success"}']?.max ||
    histograms['research_session_duration_ms{mode="quick",complexity="0",status="success"}']?.max ||
    0;

  // Rounds completed — evaluator runs give us the round count
  const roundsCompleted = sumCounter(counters, 'evaluator_runs_total');

  // Complexity
  let complexity = 1;
  for (const key of Object.keys(counters)) {
    if (key.startsWith('research_sessions_total{')) {
      const match = key.match(/complexity="(\d+)"/);
      if (match) complexity = parseInt(match[1], 10);
      break;
    }
  }

  // If nothing meaningful happened, return null
  if (researchersLaunched === 0 && searchQueries === 0 && urlsAnalyzed === 0 && tokens === 0) {
    return null;
  }

  return {
    durationMs,
    complexity,
    researchersLaunched,
    roundsCompleted,
    searchQueries,
    urlsDiscovered,
    urlsAnalyzed,
    urlsFailed,
    errors,
    tokens,
  };
}

// ---------------------------------------------------------------------------
// Final research result summary
// ---------------------------------------------------------------------------

/**
 * Build a concise, impressive summary for the END of a research result.
 *
 * Design principles:
 *   - No tables, no percentages — just counts
 *   - Highlights the volume of work done
 *   - Errors shown as a simple count, not a wall of detail
 *   - Feels like a quick achievement summary, not a diagnostic dump
 *
 * Returns empty string if no meaningful data.
 */
export function buildResearchSummary(stats: ResearchStats): string {
  const lines: string[] = [];

  lines.push('### Research Summary');

  // Core "hype" stats — emphasize volume of work
  const workLines: string[] = [];

  if (stats.researchersLaunched > 0) {
    workLines.push(`**${stats.researchersLaunched}** researcher agent${stats.researchersLaunched > 1 ? 's' : ''} dispatched`);
  }
  if (stats.searchQueries > 0) {
    workLines.push(`**${stats.searchQueries}** search queries executed`);
  }
  if (stats.urlsDiscovered > 0) {
    workLines.push(`**${stats.urlsDiscovered}** source${stats.urlsDiscovered > 1 ? 's' : ''} discovered`);
  }
  if (stats.urlsAnalyzed > 0) {
    workLines.push(`**${stats.urlsAnalyzed}** page${stats.urlsAnalyzed > 1 ? 's' : ''} scraped and analyzed`);
  }
  if (stats.roundsCompleted > 1) {
    workLines.push(`**${stats.roundsCompleted}** evaluation rounds completed`);
  }
  if (stats.tokens > 0) {
    workLines.push(`**${formatTokens(stats.tokens)}** tokens processed`);
  }
  if (stats.durationMs > 0) {
    workLines.push(`Completed in **${formatDuration(stats.durationMs)}**`);
  }

  if (workLines.length === 0) return '';

  lines.push(workLines.join(' · '));

  // Errors — single concise line, only when present
  if (stats.errors > 0) {
    const errorParts: string[] = [`${stats.errors} error${stats.errors > 1 ? 's' : ''} encountered`];
    if (stats.urlsFailed > 0) {
      errorParts.push(`${stats.urlsFailed} URL${stats.urlsFailed > 1 ? 's' : ''} could not be retrieved`);
    }
    lines.push(`*${errorParts.join(' · ')} — research completed successfully despite these.*`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Session metrics view (config TUI)
// ---------------------------------------------------------------------------

export interface SessionStats {
  sessionStartedAt: number;
  totalRuns: number;
  successfulRuns: number;
  failedRuns: number;
  totalDurationMs: number;
  totalSourcesAnalyzed: number;
  totalUrlsDiscovered: number;
  totalSearchQueries: number;
  totalTokens: number;
}

/**
 * Aggregate stats across all runs in the session history.
 */
export function aggregateSessionStats(
  runHistory: ReadonlyArray<{ durationMs: number; status: string; snapshot: IMetricsSnapshot }>
): SessionStats {
  let successfulRuns = 0;
  let failedRuns = 0;
  let totalDurationMs = 0;
  let totalSourcesAnalyzed = 0;
  let totalUrlsDiscovered = 0;
  let totalSearchQueries = 0;
  let totalTokens = 0;

  for (const run of runHistory) {
    if (run.status === 'success') successfulRuns++;
    else if (run.status === 'error') failedRuns++;

    totalDurationMs += run.durationMs || 0;

    const stats = extractRunStats(run.snapshot);
    if (stats) {
      totalSourcesAnalyzed += stats.urlsAnalyzed;
      totalUrlsDiscovered += stats.urlsDiscovered;
      totalSearchQueries += stats.searchQueries;
      totalTokens += stats.tokens;
    }
  }

  return {
    sessionStartedAt: 0, // Set by caller
    totalRuns: runHistory.length,
    successfulRuns,
    failedRuns,
    totalDurationMs,
    totalSourcesAnalyzed,
    totalUrlsDiscovered,
    totalSearchQueries,
    totalTokens,
  };
}

/**
 * Build the session-level overview section.
 */
export function buildSessionOverview(stats: SessionStats): string {
  const lines: string[] = [];

  lines.push('### Session Overview');

  const overviewParts: string[] = [];
  overviewParts.push(`**${stats.totalRuns}** research run${stats.totalRuns !== 1 ? 's' : ''}`);

  if (stats.totalSourcesAnalyzed > 0) {
    overviewParts.push(`**${stats.totalSourcesAnalyzed}** sources analyzed`);
  }
  if (stats.totalUrlsDiscovered > 0) {
    overviewParts.push(`**${stats.totalUrlsDiscovered}** URLs discovered`);
  }
  if (stats.totalSearchQueries > 0) {
    overviewParts.push(`**${stats.totalSearchQueries}** search queries`);
  }
  if (stats.totalTokens > 0) {
    overviewParts.push(`**${formatTokens(stats.totalTokens)}** tokens`);
  }
  if (stats.totalDurationMs > 0) {
    overviewParts.push(`**${formatDuration(stats.totalDurationMs)}** total research time`);
  }

  lines.push(overviewParts.join(' · '));

  return lines.join('\n');
}

/**
 * Build a compact one-line summary for a prior run.
 */
export function buildRunCompactLine(run: {
  runId: string;
  durationMs: number;
  status: string;
  completedAt: number;
  snapshot: IMetricsSnapshot;
}): string {
  const icon = run.status === 'success' ? '✓'
    : run.status === 'cancelled' ? '⊘'
    : '✗';

  const stats = extractRunStats(run.snapshot);
  const extraParts: string[] = [];

  if (stats) {
    if (stats.urlsAnalyzed > 0) {
      extraParts.push(`${stats.urlsAnalyzed} source${stats.urlsAnalyzed !== 1 ? 's' : ''}`);
    }
    if (stats.researchersLaunched > 0) {
      extraParts.push(`${stats.researchersLaunched} researcher${stats.researchersLaunched !== 1 ? 's' : ''}`);
    }
  }

  const extra = extraParts.length > 0 ? ` · ${extraParts.join(', ')}` : '';
  const ago = formatTimeAgo(new Date(run.completedAt).toISOString());

  return `- ${icon} \`${run.runId.slice(0, 8)}\` ${formatDuration(run.durationMs)}${extra} — ${ago}`;
}

export { formatDuration, formatTimeAgo };
