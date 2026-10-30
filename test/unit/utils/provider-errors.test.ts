/**
 * Provider capacity-error classification.
 *
 * Recurring evidence these pin (same signature, four separate episodes in the
 * retained logs): a researcher dies four times in ~40s on OpenRouter's shared
 * upstream pool and the run then degrades to a raw-compilation synthesis.
 *   • 2026-09-25  run-74d6a013  3 researchers exhausted, run stopped
 *   • 2026-10-21  run-7e71a226  1 researcher exhausted
 *   • 2026-10-24  run-12b98700  2 researchers exhausted
 *   • 2026-10-25  run-bfe347c3  2 of 3 exhausted, run stopped
 * All of them `inclusionai/ling-3.0-flash` via DeepInfra with
 * `provider_error_code: engine_overloaded`.
 */

import { describe, it, expect } from 'vitest';
import {
  isRateLimitError,
  isCapacityFailureReason,
  isSpentAccountError,
  parseRetryAfterMs,
  rateLimitBackoffMs,
  clampRateLimitWait,
  RATE_LIMIT_BACKOFF_BASE_MS,
  RATE_LIMIT_BACKOFF_MAX_MS,
  STATED_RETRY_AFTER_MAX_MS,
} from '../../../src/utils/provider-errors.ts';

// Verbatim shape from 2026-10-25, wrapped as pi-research's ensureAssistantResponse
// wraps it.
const REAL_429 = 'Model API rate limit (429) — wait a moment and retry. Details: 429: {"message":"Provider returned error","code":429,"metadata":{"raw":"inclusionai/ling-3.0-flash is temporarily rate-limited upstream. Please retry shortly, or add your own key to accumulate your rate limits: https://openrouter.ai/settings/integrations","provider_name":"DeepInfra","is_byok":false,"provider_error_code":"engine_overloaded","limit_source":"upstream_provider_shared_pool","remedy_hint":"Retry shortly, add your own provider key (https://openrouter.ai/settings/integrations), or route to another provider with provider routing: https://openrouter.ai/docs/features/provider-routing"}}';

describe('isRateLimitError', () => {
  it('matches the real shared-pool 429', () => {
    expect(isRateLimitError(new Error(REAL_429))).toBe(true);
  });

  it('matches the bare status forms providers actually emit', () => {
    expect(isRateLimitError(new Error('429 Too Many Requests'))).toBe(true);
    expect(isRateLimitError(new Error('Provider returned 429: slow down'))).toBe(true);
    expect(isRateLimitError(new Error('rate limited, try again'))).toBe(true);
    expect(isRateLimitError(new Error('Too many requests'))).toBe(true);
  });

  it('does not fire on a bare number that merely contains 429', () => {
    expect(isRateLimitError(new Error('usage: max_tokens=14293 not supported'))).toBe(false);
    expect(isRateLimitError(new Error('context overflow: you requested 142935 tokens'))).toBe(false);
  });

  it('matches the 5xx overload class, which is as transient as a 429', () => {
    // Verbatim shape from 2026-10-28 (issue #22): pi refuses a Retry-After longer
    // than its own cap and surfaces the provider half as a 503.
    expect(isRateLimitError(new Error(
      'Provider error - Server requested 120s retry delay (max: 60s). 503 Provider returned error',
    ))).toBe(true);
    expect(isRateLimitError(new Error('502 Bad Gateway'))).toBe(true);
    expect(isRateLimitError(new Error('504 Gateway Timeout'))).toBe(true);
    expect(isRateLimitError(new Error('500 Internal Server Error'))).toBe(true);
    expect(isRateLimitError(new Error('503 Service Unavailable'))).toBe(true);
  });

  it('does not fire on unrelated provider failures', () => {
    expect(isRateLimitError(new Error('402: this request requires more credits'))).toBe(false);
    expect(isRateLimitError(new Error('400: invalid model id'))).toBe(false);
    expect(isRateLimitError(new Error('404: model not found'))).toBe(false);
    expect(isRateLimitError(new Error('a stylesheet selector was overloaded'))).toBe(false);
  });

  it('handles non-Error rejections without throwing', () => {
    expect(isRateLimitError('429 from upstream')).toBe(true);
    expect(isRateLimitError(undefined)).toBe(false);
  });
});

// OpenAI-style out-of-quota answers 429. It is NOT a transient limit: the balance does
// not refill between attempts, so it must not borrow the rate-limit backoff and must not
// be excluded from the stop threshold (that exclusion would keep a run alive for every
// remaining round against an account that cannot pay).
const QUOTA_429 = '429: {"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota","param":null,"code":"insufficient_quota"}}';
const OPENROUTER_NO_CREDITS = '402: {"message":"This request requires more credits, or fewer max_tokens."}';

describe('isSpentAccountError', () => {
  it('recognises the quota/credits class in both provider wordings', () => {
    expect(isSpentAccountError(new Error(QUOTA_429))).toBe(true);
    expect(isSpentAccountError(new Error(OPENROUTER_NO_CREDITS))).toBe(true);
    expect(isSpentAccountError(new Error('insufficient_quota'))).toBe(true);
    // Each phrase is asserted on its own: a phrase that only ever appears inside a payload
    // carrying a sibling phrase could be deleted without failing a test.
    expect(isSpentAccountError(new Error('out of credits'))).toBe(true);
    expect(isSpentAccountError(new Error('exceeded your current quota'))).toBe(true);
    expect(isSpentAccountError(new Error('insufficient credits'))).toBe(true);
    expect(isSpentAccountError(new Error('requires more credits'))).toBe(true);
  });

  it('does not fire on a genuine transient rate limit', () => {
    expect(isSpentAccountError(new Error(REAL_429))).toBe(false);
  });
});

describe('isCapacityFailureReason', () => {
  it('classifies a recorded 429 reason as capacity', () => {
    expect(isCapacityFailureReason(REAL_429)).toBe(true);
  });

  it('treats a missing or empty reason as NOT capacity (conservative: still counts)', () => {
    expect(isCapacityFailureReason(undefined)).toBe(false);
    expect(isCapacityFailureReason('')).toBe(false);
  });

  it('does NOT treat a 429 out-of-quota as capacity (the account cannot recover)', () => {
    expect(isRateLimitError(new Error(QUOTA_429))).toBe(false);
    expect(isCapacityFailureReason(QUOTA_429)).toBe(false);
    expect(isCapacityFailureReason(OPENROUTER_NO_CREDITS)).toBe(false);
  });

  it('treats a quality failure as NOT capacity', () => {
    expect(isCapacityFailureReason('Researcher 1.1 produced an ungrounded report: scrape tool enabled but zero successful scrapes')).toBe(false);
    expect(isCapacityFailureReason('402: this request requires more credits')).toBe(false);
  });
});

describe('rateLimitBackoffMs', () => {
  const noJitter = () => 0.5; // random() = 0.5 → jitter term is exactly 0

  it('waits 15s / 30s / 60s for the three retries (no jitter)', () => {
    expect(rateLimitBackoffMs(2, null, noJitter)).toBe(15_000);
    expect(rateLimitBackoffMs(3, null, noJitter)).toBe(30_000);
    expect(rateLimitBackoffMs(4, null, noJitter)).toBe(60_000);
  });

  it('never exceeds the ceiling, however deep the retry count', () => {
    for (let attempt = 2; attempt <= 12; attempt++) {
      expect(rateLimitBackoffMs(attempt, null, noJitter)).toBeLessThanOrEqual(RATE_LIMIT_BACKOFF_MAX_MS);
    }
  });

  it('applies up to ±20% jitter so parallel researchers do not retry in lockstep', () => {
    const low = rateLimitBackoffMs(2, null, () => 0);
    const high = rateLimitBackoffMs(2, null, () => 1);
    expect(low).toBe(RATE_LIMIT_BACKOFF_BASE_MS * 0.8);
    expect(high).toBe(RATE_LIMIT_BACKOFF_BASE_MS * 1.2);
  });

  it("prefers the provider's stated window over the exponential step", () => {
    expect(rateLimitBackoffMs(2, 42_000, noJitter)).toBe(42_000);
    // A stated window longer than the EXPONENTIAL ceiling is honoured: clamping a
    // provider's 120s to 60s only guarantees the retry fails too (issue #22).
    expect(rateLimitBackoffMs(2, 120_000, noJitter)).toBe(120_000);
    // ...but it still has its own, larger ceiling.
    expect(rateLimitBackoffMs(2, 900_000, noJitter)).toBe(STATED_RETRY_AFTER_MAX_MS);
    expect(rateLimitBackoffMs(2, 10, noJitter)).toBe(1_000);
  });

  it('clampRateLimitWait keeps a wait inside [1s, 60s]', () => {
    expect(clampRateLimitWait(0)).toBe(1_000);
    expect(clampRateLimitWait(120_000)).toBe(60_000);
    expect(clampRateLimitWait(7_500)).toBe(7_500);
  });
});

describe('parseRetryAfterMs', () => {
  it('reads the header form', () => {
    expect(parseRetryAfterMs(new Error('429 retry-after: 30'))).toBe(30_000);
    expect(parseRetryAfterMs(new Error('{"retry-after":"45"}'))).toBe(45_000);
  });

  it("reads pi's refuse-the-cap sentence, which is the only statement of the window", () => {
    expect(parseRetryAfterMs(new Error(
      'Provider error - Server requested 120s retry delay (max: 60s). 503 Provider returned error',
    ))).toBe(120_000);
    expect(parseRetryAfterMs(new Error('Server requested 90s retry delay (max: 60s). 503'))).toBe(90_000);
  });

  it('reads the prose form', () => {
    expect(parseRetryAfterMs(new Error('please retry after 20s'))).toBe(20_000);
  });

  it('clamps a stated window into [5s, STATED_RETRY_AFTER_MAX_MS]', () => {
    expect(parseRetryAfterMs(new Error('retry-after: 1'))).toBe(5_000);
    expect(parseRetryAfterMs(new Error('retry-after: 3600'))).toBe(STATED_RETRY_AFTER_MAX_MS);
  });

  it('returns null when nothing is stated', () => {
    expect(parseRetryAfterMs(new Error('429 Too Many Requests'))).toBeNull();
    expect(parseRetryAfterMs(undefined)).toBeNull();
  });
});
