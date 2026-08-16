/**
 * Which researcher failures are worth retrying, decided from the log record rather
 * than from intuition.
 *
 * The retry loop had no permanent-error branch at all: every failure got the full
 * attempt budget. Across 53 days of logs that was mostly harmless, because almost
 * everything reaching this loop does recover — "produced no text output" 26/26, a
 * provider rejecting `reasoning_effort: 'none'` ~18/19 (OpenRouter routes the same
 * model to different upstream providers per request, so a retry is a routing
 * lottery that usually pays), token-limit truncation ~16/17.
 *
 * Insufficient credits is the exception with no recoveries whatsoever: 30 retried
 * attempts, all belonging to episodes that went on to exhaust, 0 of 10 recovered.
 * Those cost five runs their entire output on 2026-08-14/15 — searches already
 * paid for and discarded, and a synthesis call billed over an empty corpus.
 *
 * These tests pin the narrowness as much as the behaviour. A classifier that grew
 * to cover the recovering classes would break runs that currently succeed.
 */

import { describe, it, expect } from 'vitest';

import { isUnretriableResearcherError } from '../../../src/orchestration/researcher-executor.ts';

describe('isUnretriableResearcherError', () => {
  it('stops on the provider error that never recovered', () => {
    // Verbatim from the failing runs.
    expect(isUnretriableResearcherError(
      new Error('This request requires more credits, or fewer max_tokens. You requested up to 231037 tokens, but can only afford 24467.'),
    )).toBe(true);
    expect(isUnretriableResearcherError(new Error('Insufficient credits for this request'))).toBe(true);
    expect(isUnretriableResearcherError(new Error('insufficient_quota'))).toBe(true);
  });

  it('keeps retrying every class that the logs show recovering', () => {
    // Each of these has a measured recovery rate; refusing them would lose runs
    // that currently finish.
    expect(isUnretriableResearcherError(new Error('Researcher produced no text output'))).toBe(false);
    expect(isUnretriableResearcherError(
      new Error("Expected 'reasoning_effort' to be one of low, medium, high, found 'none'"),
    )).toBe(false);
    expect(isUnretriableResearcherError(new Error('Response was truncated by token limit, no usable text'))).toBe(false);
    expect(isUnretriableResearcherError(new Error('Researcher timed out after 900000ms'))).toBe(false);
    expect(isUnretriableResearcherError(new Error('Connection error.'))).toBe(false);
    expect(isUnretriableResearcherError(new Error('rate limit 1302'))).toBe(false);
  });

  it('does not fire on a bare status code that happens to appear in a payload', () => {
    // The gate ends a researcher's run, so it matches the provider's wording rather
    // than a number that can turn up inside a token count, a URL or a quoted body.
    expect(isUnretriableResearcherError(new Error('HTTP 402'))).toBe(false);
    expect(isUnretriableResearcherError(new Error('scraped https://example.com/402/page'))).toBe(false);
    expect(isUnretriableResearcherError(new Error('returned 402 results'))).toBe(false);
  });

  it('handles non-Error rejections without throwing', () => {
    expect(isUnretriableResearcherError('This request requires more credits')).toBe(true);
    expect(isUnretriableResearcherError(undefined)).toBe(false);
    expect(isUnretriableResearcherError(null)).toBe(false);
    expect(isUnretriableResearcherError({ nope: true })).toBe(false);
  });

  it('is case-insensitive, since provider wording is not stable', () => {
    expect(isUnretriableResearcherError(new Error('REQUIRES MORE CREDITS'))).toBe(true);
  });
});
