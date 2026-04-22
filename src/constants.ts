/**
 * Project Constants
 *
 * Centralized constants for magic numbers and configuration values.
 */

// ==================== Time Constants ====================

/** Flash duration for UI slice animations in milliseconds */
export const FLASH_DURATION_MS = 500;

/** Delay between API requests in milliseconds */
export const REQUEST_DELAY_MS_NVD = 6000;
export const REQUEST_DELAY_MS_OTHER = 1000;
export const REQUEST_DELAY_MS = 1000;

// ==================== Research Constraints ====================

/** Maximum gathering (tool) calls per researcher */
export const MAX_GATHERING_CALLS = 4;

/** Maximum scrape tool calls per researcher (3 batches: Batch 1, Batch 2, Batch 3) */
export const MAX_SCRAPE_CALLS = 3;

/** Maximum URLs to scrape per batch */
export const MAX_SCRAPE_URLS = 3;

/** Maximum siblings (researchers) allowed to run simultaneously across all rounds */
export const MAX_CONCURRENT_RESEARCHERS = 3;


// ==================== Complexity Levels ====================

export const INITIAL_RESEARCHERS_LEVEL_1 = 2;
export const INITIAL_RESEARCHERS_LEVEL_2 = 3;
export const INITIAL_RESEARCHERS_LEVEL_3 = 5;

export const MAX_ROUNDS_LEVEL_1 = 2;
export const MAX_ROUNDS_LEVEL_2 = 3;
export const MAX_ROUNDS_LEVEL_3 = 5;

export const MAX_CONCURRENT_LEVEL_1_FOLLOWUP = 1;
export const MAX_CONCURRENT_LEVEL_2_FOLLOWUP = 2;
export const MAX_CONCURRENT_LEVEL_3_FOLLOWUP = 3;

export const MAX_CONCURRENT_LEVEL_1_INITIAL = 2;
export const MAX_CONCURRENT_LEVEL_2_INITIAL = 3;
export const MAX_CONCURRENT_LEVEL_3_INITIAL = 3;

export const MAX_EXTRA_ROUNDS = 2;


// ==================== Timeout Constants ====================

export const SEARXNG_TIMEOUT_MS = 30000;
export const OSV_TIMEOUT_MS = 30000;
export const NVD_TIMEOUT_MS = 30000;

// ==================== Export Constants ====================

/** Maximum query length for filename sanitization */
export const MAX_QUERY_LENGTH = 12000;

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

// ==================== Context-Aware Scraping Constants ====================

/** Fraction of context window consumed beyond which all scraping is blocked. */
export const MAX_CONTEXT_FRACTION_FOR_SCRAPING = 0.55;

/** 
 * Fraction of SCRAPE-SOURCED tokens beyond which scraping is blocked.
 */
export const MAX_SCRAPE_TOKEN_FRACTION_FOR_SCRAPING = 0.45;

/** Estimated tokens consumed per scrape call */
export const AVG_TOKENS_PER_SCRAPE = 15000;

export const DEFAULT_MODEL_CONTEXT_WINDOW = 200000;

/** Maximum URLs per second-scrape batch (more targeted than batch 1). */
export const BATCH_2_MAX_SCRAPE_URLS = 2;

export const BATCH_2_DEFAULT_CONCURRENCY = 15;

// ==================== UI Constants ====================

export const MAX_REPORT_LENGTH = 200000;
export const PROGRESS_BAR_WIDTH = 18;

// ==================== Orchestrator Constants ====================

/** Maximum characters per researcher report when sent to lead evaluator */
export const MAX_EVALUATOR_REPORT_LENGTH = 50000;

/** Delay in milliseconds between launching concurrent researchers to stagger startup */
export const RESEARCHER_LAUNCH_DELAY_MS = 300;

export const STATE_PROPAGATION_DELAY_MS = 50;
export const STREAMING_UPDATE_THRESHOLD_CHARS = 200;
