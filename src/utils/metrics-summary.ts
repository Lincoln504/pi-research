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
  /** Number of URLs that failed to scrape (blocked, stub, HTTP error, timeout). */
  urlsFailed: number;
  /** Genuine engine faults (errored/timed-out researcher attempts). Excludes
   *  expected remote scrape unavailability, which is reported via urlsFailed. */
  errors: number;
  /** Total LLM tokens consumed. */
  tokens: number;
  /** Total cost in USD across all LLM calls. */
  cost: number;
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

  // Errors — genuine engine faults only (a researcher attempt that threw or timed
  // out; llm_api_errors_total is summed for forward-compat but no path emits it yet).
  // Deliberately EXCLUDES scrape_errors_total: a URL blocked by bot-protection,
  // returning a stub, or answering 4xx/5xx is an EXPECTED outcome of scraping the
  // open web — it is already surfaced to the user as "not scraped" (urlsFailed,
  // from the once-per-URL total_failure outcome). Counting scrape_errors_total here
  // both mislabels remote unavailability as an engine error AND over-counts, since
  // it is incremented several times along one URL's fetch→browser fallback chain.
  // A researcher whose sources were all blocked does NOT increment
  // researcher_errors_total (it takes the ungrounded path), so blocked runs
  // correctly show 0 errors here.
  const errors = sumCounter(counters, 'researcher_errors_total') +
    sumCounter(counters, 'llm_api_errors_total');

  // Tokens — sum all label variants
  const tokens = sumCounter(counters, 'llm_tokens_total');

  // Cost — sum all label variants
  const cost = sumCounter(counters, 'llm_cost_total');

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
    cost,
    toolUsage,
  };
}

// ---------------------------------------------------------------------------
// Final research result summary
// ---------------------------------------------------------------------------

/**
 * Build a concise human-readable summary for the END of a research result.
 *
 * Design principles:
 *   - One line for work done, one line for cost/resources
 *   - Errors collapsed to a single sentence (details belong in the log)
 *   - No tables, percentages, scrape-internal breakdowns, or diagnostic dumps
 *   - Consistent single bolding on key numbers
 *
 * Returns empty string if no meaningful data.
 */
export function buildResearchSummary(stats: ResearchStats): string {
  const lines: string[] = [];

  lines.push('### Research Summary');

  // --- Work line: researchers, rounds, searches, sources ---
  const workParts: string[] = [];

  if (stats.researchersLaunched > 0) {
    workParts.push(`**${stats.researchersLaunched}** researcher${stats.researchersLaunched > 1 ? 's' : ''}`);
  }
  if (stats.roundsCompleted > 1) {
    workParts.push(`**${stats.roundsCompleted}** rounds`);
  }
  if (stats.searchQueries > 0) {
    workParts.push(`**${stats.searchQueries}** searches`);
  }
  if (stats.urlsAnalyzed > 0) {
    let sourcesLabel: string;
    if (stats.urlsDiscovered > stats.urlsAnalyzed) {
      sourcesLabel = `**${stats.urlsAnalyzed}** of **${stats.urlsDiscovered}** sources analyzed`;
    } else {
      sourcesLabel = `**${stats.urlsAnalyzed}** sources analyzed`;
    }
    // Show per-tier breakdown when browser fallback was used or some URLs failed
    if (stats.browserSuccess > 0 || stats.urlsFailed > 0) {
      const tierParts: string[] = [];
      if (stats.fetchSuccess > 0) tierParts.push(`${stats.fetchSuccess} fetch`);
      if (stats.browserSuccess > 0) tierParts.push(`${stats.browserSuccess} browser`);
      if (stats.urlsFailed > 0) tierParts.push(`${stats.urlsFailed} not scraped`);
      sourcesLabel += ` (${tierParts.join(', ')})`;
    }
    workParts.push(sourcesLabel);
  } else if (stats.urlsDiscovered > 0) {
    workParts.push(`**${stats.urlsDiscovered}** sources discovered`);
  }

  if (workParts.length > 0) {
    lines.push(workParts.join(' · '));
  }

  // --- Resource line: tokens, cost, duration ---
  const resourceParts: string[] = [];
  if (stats.tokens > 0) {
    resourceParts.push(`**${formatTokens(stats.tokens)}** tokens`);
  }
  if (stats.cost > 0) {
    const costStr = stats.cost < 0.01 ? '<$0.01' : `$${stats.cost.toFixed(2)}`;
    resourceParts.push(`**${costStr}**`);
  }
  if (stats.durationMs > 0) {
    resourceParts.push(`**${formatDuration(stats.durationMs)}**`);
  }
  if (resourceParts.length > 0) {
    lines.push(resourceParts.join(' · '));
  }

  // --- Footnote: genuine engine errors only. Blocked/unavailable sources are NOT
  //     errors — they appear as "N not scraped" in the tier breakdown above. ---
  if (stats.errors > 0) {
    lines.push(`*${stats.errors} error${stats.errors > 1 ? 's' : ''} encountered.*`);
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
  const icon = run.status === 'success' ? '[ok]'
    : run.status === 'cancelled' ? '[cancelled]'
    : '[failed]';

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
