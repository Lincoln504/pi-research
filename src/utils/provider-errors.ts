/**
 * Provider capacity-error classification.
 *
 * Two places need the same answer to "is this failure the provider running out of
 * room, rather than this run being wrong?":
 *
 *  - the researcher retry loop, which must wait long enough for a shared-pool
 *    rate limit to clear instead of burning its whole retry budget in 7 seconds
 *    (researcher-executor.ts), and
 *  - the run-level failure threshold, which must not treat "every researcher hit
 *    the provider's rate limit" as "the research model cannot do this topic"
 *    (session-state.ts shouldStopResearch).
 *
 * Kept in a leaf module so neither importer has to depend on the other; the
 * executor already imports session-state, so putting the predicate there would
 * create a cycle.
 */

/**
 * A SPENT ACCOUNT, which is often reported as a 429 too.
 *
 * This is the single wording list for the class. OpenAI-style quotas answer `429` with
 * `insufficient_quota`; OpenRouter answers `402` with "requires more credits". The status
 * code cannot separate these from a transient rate limit, but the consequence is opposite:
 * the balance does not refill between attempts, so this class is unretriable AND must
 * never be treated as capacity — a run kept alive through three rounds against an account
 * that cannot pay does nothing but burn DuckDuckGo load. `isUnretriableResearcherError`
 * (researcher-executor.ts) delegates here rather than keeping a second copy.
 */
export function isSpentAccountError(error: unknown): boolean {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return msg.includes('insufficient_quota')
    || msg.includes('insufficient credits')
    || msg.includes('requires more credits')
    || msg.includes('exceeded your current quota')
    || msg.includes('out of credits');
}

/**
 * Provider wording for "too many requests right now".
 *
 * Matched on the provider's wording rather than a bare status code, for the same
 * reason as isSpentAccountError: a `429` substring can appear inside an
 * unrelated payload (a token count, a URL, a quoted response body), and this
 * predicate decides how long a researcher sleeps and whether a run keeps going.
 *
 * The real OpenRouter shape (observed 2026-10-25):
 *   `429: {"message":"Provider returned error","code":429,"metadata":{"raw":
 *    "inclusionai/ling-3.0-flash is temporarily rate-limited upstream. Please
 *    retry shortly, ...","provider_name":"DeepInfra",
 *    "provider_error_code":"engine_overloaded",
 *    "limit_source":"upstream_provider_shared_pool"}}`
 * pi-research's own wrapper adds the prefix `Model API rate limit (429) — wait a
 * moment and retry.`
 *
 * `engine_overloaded` / `provider_overloaded` are the upstream-pool variants that
 * arrive as a 429 body; matched explicitly so a bare "overloaded" cannot collide
 * with unrelated wording (e.g. a CSS/DOM "overloaded selector" in scraped text).
 */
export function isRateLimitError(error: unknown): boolean {
  // A spent account answers 429 as well; it is NOT a transient limit. Checked first so
  // no caller that forgot the distinction (backoff, stop threshold, retry policy) can
  // treat an empty balance as a temporary condition.
  if (isSpentAccountError(error)) return false;
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return /\b429\b/.test(msg)
    || msg.includes('rate limit')
    || msg.includes('rate-limit')
    || msg.includes('rate limited')
    || msg.includes('too many requests')
    || msg.includes('engine_overloaded')
    || msg.includes('provider_overloaded');
}

/**
 * The same question, asked of a recorded failure REASON (a string, not an Error).
 * A missing reason is not a capacity failure: the conservative default is to count
 * it toward the stop threshold, exactly as before this classification existed.
 */
export function isCapacityFailureReason(reason: string | undefined): boolean {
  // isRateLimitError already excludes the spent-account class, so an out-of-credits
  // failure is NOT capacity and still counts toward the stop threshold.
  return reason !== undefined && reason !== '' && isRateLimitError(reason);
}

/**
 * The `Retry-After` a provider error asked for, in ms, clamped to [5s, 60s], or null when
 * the error carries none. Read out of the message because every caller sees a serialized
 * provider error, not the raw Response headers: pi's `after_provider_response` hook
 * (src/index.ts) is the only place with headers, and it does not feed these retry loops.
 *
 * Shared (researcher loop + planning/router retries) so the two cannot drift; it lives
 * here rather than in either caller because core/ must not import orchestration/.
 */
export function parseRetryAfterMs(error: unknown): number | null {
  const message = error instanceof Error ? error.message : String(error);
  const m = /["']?retry-after["']?\s*[:=]\s*["']?(\d{1,4})/i.exec(message);
  if (!m) return null;
  const seconds = Number(m[1]);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.min(Math.max(seconds, 5), 60) * 1000;
}

/**
 * Base delay for a researcher's first retry after a rate limit. 15s, not the 1s
 * the ordinary exponential step uses: a shared-pool limit is enforced over
 * seconds-to-minutes, and the observed outage (2026-10-25) outlasted four
 * attempts spaced 1s/2s/4s by more than six minutes.
 */
export const RATE_LIMIT_BACKOFF_BASE_MS = 15_000;

/**
 * Ceiling for one rate-limit wait. The provider's own `Retry-After` wins when
 * present (clamped by parseRetryAfterMs to 60s); this only bounds the exponential
 * fallback, so three retries cost at most 15s + 30s + 60s of waiting.
 */
export const RATE_LIMIT_BACKOFF_MAX_MS = 60_000;

/**
 * How long to wait before retry `attempt` (2 = first retry).
 *
 * `retryAfterMs` is the provider's stated window when the error carried one — it
 * overrides the exponential step, because the provider knows when its pool frees
 * up and we do not. Otherwise: 15s, 30s, 60s (capped), each with ±20% jitter.
 *
 * The jitter is load-bearing, not cosmetic: every researcher in a round normally
 * retries on the same second, so without it N researchers slam the same exhausted
 * upstream pool in lockstep and all fail again, which is exactly what happened on
 * 2026-10-25 (researchers 1.1 and 1.2 retried at 15:58:03, 15:58:27 and 15:58:54
 * and failed three times each in cadence).
 */
export function rateLimitBackoffMs(
  attempt: number,
  retryAfterMs: number | null,
  random: () => number = Math.random,
): number {
  if (retryAfterMs !== null && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    return clampRateLimitWait(retryAfterMs);
  }
  const exponent = Math.max(0, attempt - 2);
  const base = Math.min(RATE_LIMIT_BACKOFF_BASE_MS * Math.pow(2, exponent), RATE_LIMIT_BACKOFF_MAX_MS);
  const jitter = base * 0.2 * (random() * 2 - 1);
  return clampRateLimitWait(base + jitter);
}

/** Keep a wait inside [1s, 60s] — the same bounds parseRetryAfterMs applies to a stated window. */
export function clampRateLimitWait(ms: number): number {
  return Math.min(Math.max(Math.round(ms), 1_000), RATE_LIMIT_BACKOFF_MAX_MS);
}
