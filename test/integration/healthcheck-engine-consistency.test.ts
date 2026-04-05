/**
 * Healthcheck Integration Test - Engine Consistency
 *
 * Validates that the healthcheck dynamically loads engines from config
 * and doesn't rely on hardcoded lists.
 */

import { describe, it, expect } from 'vitest';
import { getActiveSearxngEngines, validateEngineListConsistency } from '../../src/utils/searxng-config.js';

describe('Healthcheck Engine Consistency Integration', () => {
  it('should load engines from config dynamically', () => {
    // This simulates what healthcheck does
    const engines = getActiveSearxngEngines();
    expect(engines).toBeTruthy();
    expect(engines.length).toBeGreaterThan(0);
    expect(Array.isArray(engines)).toBe(true);
  });

  it('should return consistent engine list on multiple calls', () => {
    // Healthcheck may call this multiple times
    const engines1 = getActiveSearxngEngines();
    const engines2 = getActiveSearxngEngines();

    expect(engines1).toEqual(engines2);
  });

  it('should validate that expected healthcheck engines match config', () => {
    // These are the engines that healthcheck now expects
    // If config adds/removes engines, this validation will catch it
    const expectedHealthcheckEngines = ['google', 'bing', 'brave'];

    const validation = validateEngineListConsistency(expectedHealthcheckEngines);

    // Should match (this is what healthcheck expects)
    expect(validation.isValid).toBe(true);
    expect(validation.missing).toHaveLength(0);
    expect(validation.extra).toHaveLength(0);
  });

  it('should detect drift if someone adds a disabled engine to the config', () => {
    // This test documents what would happen if someone
    // re-enables duckduckgo without updating tests

    const actualEngines = getActiveSearxngEngines();

    // Current expectation (should be true)
    expect(actualEngines).not.toContain('duckduckgo');

    // If this ever fails, duckduckgo was re-enabled and we need to:
    // 1. Fix the CAPTCHA issue (good luck with that!)
    // 2. Add it back to healthcheck expectations
    // 3. Update the config validation tests
  });

  it('should filter out category-specific and encyclopedic engines', () => {
    const engines = getActiveSearxngEngines();

    // Should not include these even if they're in the config
    const shouldNotInclude = [
      'wikipedia', // encyclopedic
      'bing images',
      'bing news',
      'bing videos',
      'duckduckgo images',
      'duckduckgo news',
      'duckduckgo videos',
      'stackoverflow', // category: it
      'arxiv', // category: science
      'semantic scholar', // category: science
    ];

    for (const engine of shouldNotInclude) {
      expect(engines).not.toContain(engine.toLowerCase());
    }
  });

  it('should only return general web search engines', () => {
    const engines = getActiveSearxngEngines();

    // Only these are general purpose web search engines
    const allowedEngines = ['google', 'bing', 'brave', 'startpage', 'mojeek', 'qwant'];

    for (const engine of engines) {
      expect(allowedEngines).toContain(engine);
    }
  });
});
