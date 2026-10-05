/**
 * Unit tests for the provider in-flight-budget handling added on 2026-10-05.
 *
 * A research run against OpenRouter on a busy account fails researchers with a 402
 * whose wording is "This request would exceed your available credits given your current
 * in-flight requests" plus `"Retry-After":"120"`. That is NOT the spent-balance class
 * `isUnretriableResearcherError` was written for: the condition clears once the account's
 * own open requests settle, so it must stay retriable — but the ordinary 1-2s exponential
 * backoff cannot outlast a 120s window, so the run burned its three attempts and then
 * degraded to a raw-compilation synthesis. These helpers let the loop wait the provider's
 * stated time instead.
 *
 * Both are matched on provider wording, never a bare status code, because a `402` substring
 * can appear in an unrelated payload (a token count, a URL, a quoted response body).
 */

import { describe, it, expect } from 'vitest';
import { isInFlightBudgetError, parseRetryAfterMs, isUnretriableResearcherError } from '../../../src/orchestration/researcher-executor.ts';

const REAL_MESSAGE = '2.1: Provider error - 402: {"message":"This request would exceed your available credits given your current in-flight requests. Retry after in-flight requests settle, or add credits.","code":402,"metadata":{"reason":"in_flight_budget_exhausted","limit_source":"openrouter_in_flight_budget","headers":{"Retry-After":"120"}}}';

describe('isInFlightBudgetError', () => {
  it('matches the real OpenRouter in-flight-budget 402', () => {
    expect(isInFlightBudgetError(new Error(REAL_MESSAGE))).toBe(true);
  });

  it('does NOT match the spent-balance class (that one stops immediately)', () => {
    const spent = 'Provider error - 402: {"message":"This request requires more credits, or fewer max_tokens."}';
    expect(isInFlightBudgetError(new Error(spent))).toBe(false);
    expect(isUnretriableResearcherError(new Error(spent))).toBe(true);
  });

  it('does not fire on an unrelated payload that merely contains 402', () => {
    expect(isInFlightBudgetError(new Error('usage: max_tokens=402 not supported'))).toBe(false);
  });
});

describe('parseRetryAfterMs', () => {
  it('reads the Retry-After out of the real message and clamps to 60s', () => {
    expect(parseRetryAfterMs(new Error(REAL_MESSAGE))).toBe(60000);
  });

  it('honors a small value but floors it at 5s', () => {
    expect(parseRetryAfterMs(new Error('{"headers":{"Retry-After":"2"}}'))).toBe(5000);
  });

  it('accepts the header-style spelling', () => {
    expect(parseRetryAfterMs(new Error('retry-after: 30'))).toBe(30000);
  });

  it('returns null when the error carries no Retry-After', () => {
    expect(parseRetryAfterMs(new Error('Provider error - 429: slow down'))).toBeNull();
    expect(parseRetryAfterMs(new Error('retry-after: 0'))).toBeNull();
    expect(parseRetryAfterMs(new Error('retry-after: abc'))).toBeNull();
  });
});
