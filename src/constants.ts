/**
 * Project Constants
 *
 * Centralized constants for magic numbers and configuration values.
 */

import { getConfig, type Config } from './config.ts';

// ==================== Time Constants ====================

/** Delay between API requests in milliseconds */
export const REQUEST_DELAY_MS_NVD = 6000;
export const REQUEST_DELAY_MS_OTHER = 1000;

// ==================== Research Constraints ====================

/** Maximum gathering (tool) calls per researcher (search, security_search, stackexchange, grep — shared budget) */
export const MAX_GATHERING_CALLS = 10;

/**
 * Get the maximum scrape batches from config.
 * This function should be used instead of MAX_SCRAPE_CALLS to support dynamic configuration.
 */
export function getMaxScrapeBatches(config?: Config): number {
  try {
    const batches = (config || getConfig()).MAX_SCRAPE_BATCHES;
    return batches === 0 || batches > 99 ? 999999 : batches;
  } catch {
    return 3; // Fallback to default
  }
}

/** Maximum URLs to scrape per batch (Batch 1 and 2) */
export const MAX_SCRAPE_URLS = 4;

/**
 * Get the units per researcher for the progress bar.
 * Units = 1 (for start/search) + number of scrape batches.
 */
export function getUnitsPerResearcher(config?: Config): number {
  return 1 + getMaxScrapeBatches(config);
}

/** Progress bar weight per individual researcher (Legacy, use getUnitsPerResearcher) */
export const UNITS_PER_RESEARCHER = 10;
/** Progress bar weight per lead evaluator round */
export const LEAD_EVAL_UNITS = 2;


// ==================== Complexity Levels ====================

/** Maximum researchers (siblings) in any single round per complexity level */
export const MAX_TEAM_SIZE_LEVEL_1 = 2;
export const MAX_TEAM_SIZE_LEVEL_2 = 3;
export const MAX_TEAM_SIZE_LEVEL_3 = 5;

/** Maximum research rounds per complexity level */
export const MAX_ROUNDS_LEVEL_1 = 2;
export const MAX_ROUNDS_LEVEL_2 = 3;
export const MAX_ROUNDS_LEVEL_3 = 5;


// ==================== Timeout Constants ====================

export const OSV_TIMEOUT_MS = 30000;
export const NVD_TIMEOUT_MS = 30000;

// ==================== Export Constants ====================

/** Maximum query length for validation */
export const MAX_QUERY_LENGTH = 12000;

/** Maximum query length for filename sanitization */
export const MAX_FILENAME_QUERY_LENGTH = 150;

/** Minimum query length */
export const MIN_QUERY_LENGTH = 3;

/** Maximum retry attempts for export file collision */
export const MAX_EXPORT_RETRIES = 3;

// ==================== Retry Constants ====================

/** Default maximum retry attempts for transient errors */
export const DEFAULT_MAX_RETRIES = 3;

/** Default initial delay for exponential backoff in milliseconds */
export const DEFAULT_INITIAL_DELAY_MS = 1000;

/** Default maximum delay for exponential backoff in milliseconds */
export const DEFAULT_MAX_DELAY_MS = 10000;

// ==================== Scraping Constants ====================

export const DEFAULT_MODEL_CONTEXT_WINDOW = 200000;

/** Default concurrency for batch 2 and beyond (higher than batch 1's 10) */
export const BATCH_2_DEFAULT_CONCURRENCY = 15;

// ==================== UI Constants ====================

export const MAX_REPORT_LENGTH = 200000;
export const PROGRESS_BAR_WIDTH = 18;

// ==================== Orchestrator Constants ====================

/**
 * Extra rounds the lead evaluator may earn beyond targetRounds when critical gaps remain.
 * Rounds targetRounds+1 through targetRounds+MAX_EXTRA_ROUNDS are "bonus" territory.
 * Round targetRounds+MAX_EXTRA_ROUNDS+1 is unreachable (hard limit).
 */
export const MAX_EXTRA_ROUNDS = 2;

/** Delay in milliseconds between launching concurrent researchers to stagger browser pool startup */
export const RESEARCHER_LAUNCH_DELAY_MS = 1500;

/** Hard cap on search queries per researcher, enforced after LLM planning */
export const MAX_QUERIES_PER_RESEARCHER_LEVEL_1 = 10;
export const MAX_QUERIES_PER_RESEARCHER_LEVEL_2 = 20;
export const MAX_QUERIES_PER_RESEARCHER_LEVEL_3 = 30;
