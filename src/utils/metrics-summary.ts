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
  /** Number of URLs successfully scraped via lightweight fetch. */
  fetchSuccess: number;
  /** Number of URLs successfully scraped via browser (stealth fallback). */
  browserSuccess: number;
  /** Number of URLs that fell back from fetch to browser. */
  browserFallbacks: number;
  /** Number of URLs successfully scraped/analyzed (fetch + browser). */
  urlsAnalyzed: number;
  /** Number of URLs that failed to scrape. */
  urlsFailed: number;
  /** Total errors encountered during the run. */
  errors: number;
  /** Total LLM tokens consumed. */
  tokens: number;
  /** Tool usage counts. */
  toolUsage: {
    searches: number;
    scrapes: number;
    securitySearches: number;
    stackexchangeQueries: number;
    knowledgeLookups: number;
  };
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
  const browserFallbacks = sumCounter(counters, 'scrape_layer_fallbacks_total');
  const urlsAnalyzed = fetchSuccess + browserSuccess;
  const urlsFailed = totalFailure;

  // Tool usage
  const toolUsage = {
    searches: sumCounter(counters, 'tool_search_calls_total'),
    scrapes: sumCounter(counters, 'tool_scrape_calls_total'),
    securitySearches: sumCounter(counters, 'tool_security_search_calls_total'),
    stackexchangeQueries: sumCounter(counters, 'stackexchange_requests_total'),
    knowledgeLookups: sumCounter(counters, 'research_knowledge_search_total'),
  };

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
      if (match?.[1]) complexity = parseInt(match[1], 10);
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
    fetchSuccess,
    browserSuccess,
    browserFallbacks,
    urlsAnalyzed,
    urlsFailed,
    errors,
    tokens,
    toolUsage,
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
 *   - Shows scrape layer breakdown (fetch vs browser)
 *   - Shows which tools were used
 *   - Errors show top patterns and affected domains
 *   - Feels informative but not like a diagnostic dump
 *
 * Returns empty string if no meaningful data.
 */
export function buildResearchSummary(
  stats: ResearchStats,
  errorReport?: { totalErrors: number; patterns: Array<{ message: string; count: number }>; byDomain: Map<string, number>; byType: Map<string, number> } | null,
): string {
  const lines: string[] = [];

  lines.push('### Research Summary');

  // --- Core activity stats ---
  const workParts: string[] = [];

  if (stats.researchersLaunched > 0) {
    workParts.push(`**${stats.researchersLaunched}** researcher${stats.researchersLaunched > 1 ? 's' : ''} dispatched`);
  }
  if (stats.roundsCompleted > 1) {
    workParts.push(`**${stats.roundsCompleted}** evaluation rounds`);
  }
  if (workParts.length > 0) {
    lines.push(workParts.join(' · '));
  }

  // --- Discovery & analysis ---
  const discoveryParts: string[] = [];
  if (stats.searchQueries > 0) {
    discoveryParts.push(`**${stats.searchQueries}** search queries`);
  }
  if (stats.urlsDiscovered > 0) {
    discoveryParts.push(`**${stats.urlsDiscovered}** source${stats.urlsDiscovered > 1 ? 's' : ''} discovered`);
  }
  if (stats.urlsAnalyzed > 0) {
    // Show scrape layer breakdown
    const layerParts: string[] = [`${stats.urlsAnalyzed} analyzed`];
    if (stats.fetchSuccess > 0 && stats.browserSuccess > 0) {
      layerParts.push(`${stats.fetchSuccess} via fetch`);
      layerParts.push(`${stats.browserSuccess} via browser`);
    }
    if (stats.browserFallbacks > 0) {
      layerParts.push(`${stats.browserFallbacks} fetch→browser fallback${stats.browserFallbacks > 1 ? 's' : ''}`);
    }
    discoveryParts.push(`**${layerParts.join(', ')}**`);
  }
  if (discoveryParts.length > 0) {
    lines.push(discoveryParts.join(' · '));
  }

  // --- Tools used ---
  const toolParts: string[] = [];
  if (stats.toolUsage.searches > 0) {
    toolParts.push(`${stats.toolUsage.searches} searches`);
  }
  if (stats.toolUsage.scrapes > 0) {
    toolParts.push(`${stats.toolUsage.scrapes} scrapes`);
  }
  if (stats.toolUsage.securitySearches > 0) {
    toolParts.push(`${stats.toolUsage.securitySearches} security lookups`);
  }
  if (stats.toolUsage.stackexchangeQueries > 0) {
    toolParts.push(`${stats.toolUsage.stackexchangeQueries} StackExchange queries`);
  }
  if (stats.toolUsage.knowledgeLookups > 0) {
    toolParts.push(`${stats.toolUsage.knowledgeLookups} knowledge store queries`);
  }
  if (toolParts.length > 0) {
    lines.push(`Tools: ${toolParts.join(' · ')}`);
  }

  // --- Resources ---
  const resourceParts: string[] = [];
  if (stats.tokens > 0) {
    resourceParts.push(`**${formatTokens(stats.tokens)}** tokens`);
  }
  if (stats.durationMs > 0) {
    resourceParts.push(`completed in **${formatDuration(stats.durationMs)}**`);
  }
  if (resourceParts.length > 0) {
    lines.push(resourceParts.join(' · '));
  }

  // --- Errors ---
  if (stats.errors > 0 && errorReport && errorReport.totalErrors > 0) {
    const errorLines: string[] = [];
    errorLines.push(`${errorReport.totalErrors} error${errorReport.totalErrors > 1 ? 's' : ''} encountered`);

    // Top error patterns (up to 3, just message + count)
    if (errorReport.patterns.length > 0) {
      const topPatterns = errorReport.patterns.slice(0, 3);
      for (const p of topPatterns) {
        errorLines.push(`- ${p.count}× ${p.message}`);
      }
    }

    // Affected domains (up to 5, just domain + count)
    if (errorReport.byDomain.size > 0) {
      const sortedDomains = Array.from(errorReport.byDomain.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);
      const domainStr = sortedDomains.map(([d, c]) => `${d} (${c})`).join(', ');
      errorLines.push(`Affected domains: ${domainStr}`);
    }

    // Unretrievable URLs
    if (stats.urlsFailed > 0) {
      errorLines.push(`${stats.urlsFailed} URL${stats.urlsFailed > 1 ? 's' : ''} could not be retrieved`);
    }

    lines.push(`*${errorLines.join('\n')}*`);
  } else if (stats.errors > 0) {
    // No detailed error report — just show counts
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
  totalToolUsage: {
    searches: number;
    scrapes: number;
    securitySearches: number;
    stackexchangeQueries: number;
    knowledgeLookups: number;
  };
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
  const totalToolUsage = {
    searches: 0,
    scrapes: 0,
    securitySearches: 0,
    stackexchangeQueries: 0,
    knowledgeLookups: 0,
  };

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
      totalToolUsage.searches += stats.toolUsage.searches;
      totalToolUsage.scrapes += stats.toolUsage.scrapes;
      totalToolUsage.securitySearches += stats.toolUsage.securitySearches;
      totalToolUsage.stackexchangeQueries += stats.toolUsage.stackexchangeQueries;
      totalToolUsage.knowledgeLookups += stats.toolUsage.knowledgeLookups;
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
    totalToolUsage,
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

  // Tool usage line
  const toolParts: string[] = [];
  if (stats.totalToolUsage.searches > 0) toolParts.push(`${stats.totalToolUsage.searches} searches`);
  if (stats.totalToolUsage.scrapes > 0) toolParts.push(`${stats.totalToolUsage.scrapes} scrapes`);
  if (stats.totalToolUsage.securitySearches > 0) toolParts.push(`${stats.totalToolUsage.securitySearches} security lookups`);
  if (stats.totalToolUsage.stackexchangeQueries > 0) toolParts.push(`${stats.totalToolUsage.stackexchangeQueries} StackExchange queries`);
  if (stats.totalToolUsage.knowledgeLookups > 0) toolParts.push(`${stats.totalToolUsage.knowledgeLookups} knowledge store queries`);
  if (toolParts.length > 0) {
    lines.push(`Tools used: ${toolParts.join(' · ')}`);
  }

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
