/**
 * Project Constants
 *
 * Centralized constants for magic numbers and configuration values.
 */

// ==================== Time Constants ====================

/** Flash duration for UI slice animations in milliseconds */
export const FLASH_DURATION_MS = 500;

/** Delay between API requests in milliseconds (e.g., NVD rate limit) */
export const REQUEST_DELAY_MS = 6500;

// ==================== Research Constraints ====================

/** Maximum gathering (tool) calls per researcher */
export const MAX_GATHERING_CALLS = 4;

/** Maximum URLs to scrape per batch */
export const MAX_SCRAPE_URLS = 3;

/** Maximum siblings (researchers) per round for complexity level 1 (Brief) */
export const MAX_SIBLINGS_ROUND_1 = 1;

/** Maximum siblings (researchers) per round for complexity level 2 (Normal) */
export const MAX_SIBLINGS_ROUND_2 = 2;

/** Maximum siblings (researchers) per round for complexity level 3 (Deep) */
export const MAX_SIBLINGS_ROUND_3 = 3;

/** Maximum siblings (researchers) per round for complexity level 4 (Ultra) */
export const MAX_SIBLINGS_ROUND_4 = 5;

/** Maximum researchers allowed to run simultaneously across all rounds */
export const MAX_CONCURRENT_RESEARCHERS = 3;


// ==================== Complexity Levels ====================

/** Initial researcher count for complexity level 1 (Brief) */
export const INITIAL_RESEARCHERS_LEVEL_1 = 1;

/** Initial researcher count for complexity level 2 (Normal) */
export const INITIAL_RESEARCHERS_LEVEL_2 = 2;

/** Initial researcher count for complexity level 3 (Deep) */
export const INITIAL_RESEARCHERS_LEVEL_3 = 3;

/** Initial researcher count for complexity level 4 (Ultra) */
export const INITIAL_RESEARCHERS_LEVEL_4 = 5;


/** Maximum rounds for complexity level 1 (Brief) */
export const MAX_ROUNDS_LEVEL_1 = 1;

/** Maximum rounds for complexity level 2 (Normal) */
export const MAX_ROUNDS_LEVEL_2 = 2;

/** Maximum rounds for complexity level 3 (Deep) */
export const MAX_ROUNDS_LEVEL_3 = 3;

/** Maximum rounds for complexity level 4 (Ultra) */
export const MAX_ROUNDS_LEVEL_4 = 5;


// ==================== Timeout Constants ====================

/** Default timeout for SearXNG requests in milliseconds */
export const SEARXNG_TIMEOUT_MS = 30000;

/** Default timeout for OSV API requests in milliseconds */
export const OSV_TIMEOUT_MS = 30000;

/** Default timeout for NVD API requests in milliseconds */
export const NVD_TIMEOUT_MS = 30000;

// ==================== Export Constants ====================

/** Maximum query length for filename sanitization */
export const MAX_QUERY_LENGTH = 50;

/** Hash character length for export filenames */
export const HASH_LENGTH = 2;

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

/**
 * Fraction of context window consumed beyond which all scraping is blocked.
 * At or above this threshold, researchers skip batches and move to synthesis.
 */
export const MAX_CONTEXT_FRACTION_FOR_SCRAPING = 0.50;

/**
 * Stricter threshold for the optional third scrape batch.
 * Batch 3 only runs if context usage is below this fraction.
 */
export const MAX_CONTEXT_FRACTION_FOR_BATCH3 = 0.40;

/**
 * Estimated tokens consumed per scrape call (handshake + content).
 * Used to project whether another batch is feasible given remaining context.
 */
export const AVG_TOKENS_PER_SCRAPE = 15000;

/**
 * Fallback context window size (tokens) when the model does not advertise one.
 * Corresponds to typical large-context models (Sonnet, Gemini 1.5 Pro, etc.).
 */
export const DEFAULT_MODEL_CONTEXT_WINDOW = 200000;

/**
 * Maximum URLs per second-scrape batch (more targeted than batch 1).
 * Kept lower to preserve context for synthesis after focused follow-up.
 */
export const BATCH_2_MAX_SCRAPE_URLS = 2;

/**
 * Default maxConcurrency for the second scrape batch.
 * Higher than batch 1 because batch 2 URLs are already prioritized.
 */
export const BATCH_2_DEFAULT_CONCURRENCY = 15;

// ==================== UI Constants ====================

/** Maximum characters for final report before truncation */
export const MAX_REPORT_LENGTH = 20000;

/** Visual width of the ====------ progress bar in the TUI header */
export const PROGRESS_BAR_WIDTH = 18;
