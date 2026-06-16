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

/** Duration (ms) for a green (success) flash on a researcher column */
export const FLASH_GREEN_DURATION_MS = 400;

/** Duration (ms) for a red (failure) flash on a researcher column */
export const FLASH_RED_DURATION_MS = 700;

/** Duration (ms) for a tool status 'pop' (word flash) in a researcher column */
export const FLASH_STATUS_DURATION_MS = 800;

/** Minimum gap (ms) between queued flashes for the same researcher column */
export const FLASH_QUEUE_GAP_MS = 150;

// ==================== Research Constraints ====================

/** Maximum gathering (tool) calls per researcher (search, security_search, stackexchange, grep — shared budget) */
export const MAX_GATHERING_CALLS = 12;

/**
 * Get the maximum scrape batches from config.
 * This function should be used instead of MAX_SCRAPE_CALLS to support dynamic configuration.
 */
export function getMaxScrapeBatches(config?: Config): number {
  try {
    const batches = (config || getConfig()).MAX_SCRAPE_BATCHES;
    return batches === 0 || batches > 99 ? 999999 : batches;
  } catch {
    return 2; // Fallback to default
  }
}

/** Maximum URLs to scrape per batch */
export const MAX_SCRAPE_URLS = 6;

/**
 * Get the units per researcher for the progress bar.
 * Units = 1 (for start/search) + number of scrape batches.
 * When batches are unlimited (MAX_SCRAPE_BATCHES=0), caps at 4 for a sane progress estimate.
 */
export function getUnitsPerResearcher(config?: Config): number {
  const batches = getMaxScrapeBatches(config);
  return 1 + Math.min(batches, 4);
}

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
export const MAX_ROUNDS_LEVEL_3 = 3;

/**
 * Additional research rounds allowed past MAX_ROUNDS_LEVEL_n when queued
 * steering messages exist at the end of the last planned round. Each
 * consumed steering message unlocks one more round, up to this cap per
 * session. This lets the user push research deeper via Alt+Enter even
 * after the normal round budget is exhausted, without letting steering
 * spin research forever.
 */
export const MAX_EXTRA_ROUNDS_WITH_STEERING = 2;


// ==================== Timeout Constants ====================

export const OSV_TIMEOUT_MS = 10000;

// ==================== Export Constants ====================

/** Maximum query length for validation */
export const MAX_QUERY_LENGTH = 100000;

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

/** Default concurrency for batch 2 and beyond (higher than the configurable Batch 1 concurrency, default 3) */
export const BATCH_2_DEFAULT_CONCURRENCY = 15;

// ==================== UI Constants ====================


// ==================== Orchestrator Constants ====================

/** Delay in milliseconds between launching concurrent researchers to stagger browser pool startup */
export const RESEARCHER_LAUNCH_DELAY_MS = 1500;

/** Hard cap on search queries per researcher, enforced after LLM planning */
export const MAX_QUERIES_PER_RESEARCHER_LEVEL_1 = 10;
export const MAX_QUERIES_PER_RESEARCHER_LEVEL_2 = 15;
export const MAX_QUERIES_PER_RESEARCHER_LEVEL_3 = 20;
