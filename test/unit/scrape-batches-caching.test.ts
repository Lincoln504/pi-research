/**
 * Effective scrape-batch count under prompt caching.
 *
 * When prompt caching is active for a run's resolved model, the EFFECTIVE
 * per-researcher scrape-batch maximum is the configured value plus one — the
 * cached system-prompt/tool-definition prefix makes the extra batch's context
 * re-send cheap. Every consumer (tracker enforcement, prompt text, progress
 * units) must agree on that effective number, so the arithmetic lives in one
 * place (getMaxScrapeBatches) and everything else passes the flag through.
 *
 * isPromptCachingActiveForModel is the conservative client-side gate for the
 * flag: it may only ever answer true when caching is DEFINITELY active
 * (anthropic-messages native caching, or an explicit openai-completions
 * cacheControlFormat:'anthropic' opt-in) — a false positive would raise the
 * batch limit without the caching discount that pays for it.
 */

import { describe, it, expect } from 'vitest';
import { getMaxScrapeBatches, getUnitsPerResearcher } from '../../src/constants.ts';
import { isPromptCachingActiveForModel } from '../../src/core/llm/research-model-resolver.ts';
import type { Config } from '../../src/config.ts';

const cfg = (batches: number): Config => ({ MAX_SCRAPE_BATCHES: batches } as unknown as Config);

describe('getMaxScrapeBatches with cachingActive', () => {
  it('returns the configured value unchanged when caching is not active', () => {
    expect(getMaxScrapeBatches(cfg(2))).toBe(2);
    expect(getMaxScrapeBatches(cfg(2), false)).toBe(2);
    expect(getMaxScrapeBatches(cfg(5), false)).toBe(5);
  });

  it('returns the configured value plus one when caching is active', () => {
    expect(getMaxScrapeBatches(cfg(2), true)).toBe(3);
    expect(getMaxScrapeBatches(cfg(1), true)).toBe(2);
    expect(getMaxScrapeBatches(cfg(5), true)).toBe(6);
  });

  it('leaves the unlimited sentinel unlimited regardless of caching', () => {
    expect(getMaxScrapeBatches(cfg(0), true)).toBe(999999);
    expect(getMaxScrapeBatches(cfg(0), false)).toBe(999999);
    expect(getMaxScrapeBatches(cfg(100), true)).toBe(999999);
  });

  it('never promotes a finite configured maximum into the unlimited band (99 + 1 stays 99, not 100)', () => {
    // Every renderer treats >99 as "unlimited"; a configured 99 (the documented
    // max) plus the caching increment must not cross that line — the prompt
    // would claim unlimited batches while enforcement blocked at 100.
    expect(getMaxScrapeBatches(cfg(99), true)).toBe(99);
    expect(getMaxScrapeBatches(cfg(99), false)).toBe(99);
    expect(getMaxScrapeBatches(cfg(98), true)).toBe(99);
  });
});

describe('getUnitsPerResearcher with cachingActive', () => {
  it('progress units track the effective batch count, not the base configured value', () => {
    // base 2 batches → 1 + 2 = 3 units; caching → 1 + 3 = 4 units
    expect(getUnitsPerResearcher(cfg(2))).toBe(3);
    expect(getUnitsPerResearcher(cfg(2), true)).toBe(4);
  });

  it('still caps the unlimited sentinel at 4 batches for the estimate', () => {
    expect(getUnitsPerResearcher(cfg(0), true)).toBe(5);
  });
});

describe('isPromptCachingActiveForModel', () => {
  it('is true for anthropic-messages (native, always-on caching)', () => {
    expect(isPromptCachingActiveForModel({ api: 'anthropic-messages' } as any)).toBe(true);
  });

  it('is true for openai-completions ONLY with the explicit anthropic cache-control opt-in', () => {
    expect(isPromptCachingActiveForModel({ api: 'openai-completions', compat: { cacheControlFormat: 'anthropic' } } as any)).toBe(true);
    expect(isPromptCachingActiveForModel({ api: 'openai-completions', compat: {} } as any)).toBe(false);
    expect(isPromptCachingActiveForModel({ api: 'openai-completions' } as any)).toBe(false);
  });

  it('is false (conservative) for every implicit-caching provider and for no model', () => {
    // These providers may well cache server-side, but there is no client-visible
    // "will it be active" signal — a false negative is fine, a false positive is a bug.
    for (const api of ['openai-responses', 'google-generative-ai', 'google-vertex', 'mistral-conversations', 'bedrock-converse-stream']) {
      expect(isPromptCachingActiveForModel({ api } as any)).toBe(false);
    }
    expect(isPromptCachingActiveForModel(undefined)).toBe(false);
  });
});
