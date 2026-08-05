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

/** Maximum gathering (tool) calls per researcher (search, security_search, stackexchange, youtube_transcript — shared web-API budget).
 *  This is the schema default; use getMaxGatheringCalls(config) for the configured value. */
export const MAX_GATHERING_CALLS = 12;

/** Maximum local grep (ripgrep) calls per researcher. grep is local/free and does not hit
 *  rate-limited web APIs, so it has its own generous budget instead of sharing the gathering
 *  pool — but it is still bounded to prevent a pathological search loop. */
export const MAX_GREP_CALLS = 30;

/**
 * Get the maximum gathering calls from config (env/config-file driven, mirrors getMaxScrapeBatches).
 * Not surfaced in the TUI — advanced knob only.
 */
export function getMaxGatheringCalls(config?: Config): number {
  try {
    return (config || getConfig()).MAX_GATHERING_CALLS;
  } catch {
    return MAX_GATHERING_CALLS; // Fallback to default
  }
}

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

/**
 * Hard cap for the out-of-process WebGPU viability probe when the embedding model
 * is ALREADY cached on disk. A real WebGPU init on a capable host completes in
 * ~1-3s; this bounds the fall-back-to-CPU on a GPU-less host (headless VM/CI/
 * software-Vulkan) to seconds instead of the multi-minute model-init budget. The
 * first-ever run (model not yet downloaded) keeps the full init budget — see
 * resolveEmbeddingDevice. Mirrors the cached-pipeline 30s reuse in embedder.ts.
 */
export const WEBGPU_PROBE_TIMEOUT_MS = 30_000;

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

/** Upper bound on batch-2+ scrape concurrency; the caller additionally caps this
 *  to the real browser-pool capacity (WORKER_THREADS × WORKER_CONCURRENCY). */
export const BATCH_2_DEFAULT_CONCURRENCY = 15;

/**
 * Per-document cap (in characters) on scraped content that flows into LLM
 * context — the scrape tool result and the session scraped-content cache
 * (shared-links), whose entries are re-served into researcher sessions and
 * embedded by the knowledge store.
 *
 * The scraper itself caps only RAW bytes (25MB HTML / 100MB PDF — see
 * scraper-types.ts), and the pre-scrape context gate bills a flat
 * AVG_TOKENS_PER_SCRAPE (~2500 tokens) per URL, so without this cap a single
 * huge PDF/page could inject millions of tokens into a researcher session,
 * overflow its context window, and kill the run.
 *
 * 500k chars ≈ 125k tokens: a deliberately permissive ceiling — real articles
 * and long-form docs are never cut; only pathological pages (multi-hundred-page
 * PDFs, dumps) hit it. This is a backstop against the multi-million-token
 * blowout, not a tuning knob: the post-batch context gate handles ordinary
 * budget pressure. Truncation appends an explicit "[content truncated: …]"
 * marker (see truncateWithMarker).
 */
export const MAX_SCRAPE_CONTENT_CHARS_PER_DOC = 500_000;

// ==================== Orchestrator Constants ====================

/** Delay in milliseconds between launching concurrent researchers to stagger browser pool startup */
export const RESEARCHER_LAUNCH_DELAY_MS = 1500;

/** Hard cap on search queries per researcher, enforced after LLM planning */
export const MAX_QUERIES_PER_RESEARCHER_LEVEL_1 = 10;
export const MAX_QUERIES_PER_RESEARCHER_LEVEL_2 = 15;
export const MAX_QUERIES_PER_RESEARCHER_LEVEL_3 = 20;

/**
 * Tools excluded from every researcher unless the caller says otherwise.
 *
 * `grep` is developer-only: during WEB research a high-capability model otherwise
 * spends turns searching the local filesystem instead of the internet.
 */
export const DEFAULT_EXCLUDED_TOOLS: readonly string[] = ['grep'];

/**
 * Resolve the effective researcher exclusion list.
 *
 * An EMPTY array is "no preference", not "exclude nothing". The two front-ends
 * express no-preference differently — the pi extension always builds an array
 * (`[...new Set([...])]`, often empty) while the CLI omits the key entirely — so a
 * plain truthiness test made the same user input mean opposite things: grep was
 * available in the extension and excluded on the CLI, regardless of depth.
 *
 * `configDisabled` (PI_RESEARCH_DISABLED_TOOLS) is strictly ADDITIVE. Folding it in
 * as a replacement meant disabling any unrelated tool silently ENABLED grep, so a
 * subtract-only setting could grant a capability.
 */
export function resolveExcludedTools(
  callerExclusions: readonly string[] | undefined,
  configDisabled: readonly string[] = [],
): string[] {
  const base = callerExclusions && callerExclusions.length > 0
    ? callerExclusions
    : DEFAULT_EXCLUDED_TOOLS;
  return [...new Set([...base, ...configDisabled])];
}
