/**
 * SearXNG Configuration Validation Tests
 *
 * Ensures that:
 * 1. The config file has at least one active general search engine
 * 2. Engine list loading works correctly
 * 3. Disabled engines are properly filtered
 */

import { describe, it, expect } from 'vitest';
import { getActiveSearxngEngines, validateEngineListConsistency } from '../../src/utils/searxng-config.js';

describe('SearXNG Configuration Validation', () => {
  describe('getActiveSearxngEngines()', () => {
    it('should return non-empty list of active general search engines', () => {
      const engines = getActiveSearxngEngines();
      expect(engines).toBeTruthy();
      expect(engines.length).toBeGreaterThan(0);
    });

    it('should not include disabled engines', () => {
      const engines = getActiveSearxngEngines();
      // DuckDuckGo is disabled in the config
      expect(engines).not.toContain('duckduckgo');
    });

    it('should not include encyclopedic engines (wikipedia)', () => {
      const engines = getActiveSearxngEngines();
      expect(engines).not.toContain('wikipedia');
    });

    it('should not include category-specific engines', () => {
      const engines = getActiveSearxngEngines();
      // Should not include engines like "bing images", "bing news", etc.
      const categorySpecific = [
        'images', 'news', 'videos', // variant category engines
        'stackoverflow', // IT category
        'arxiv', 'semantic', // Science category
      ];

      for (const engine of engines) {
        for (const category of categorySpecific) {
          expect(engine).not.toContain(category.toLowerCase());
        }
      }
    });

    it('should include at least google, bing, or brave', () => {
      const engines = getActiveSearxngEngines();
      const hasGeneralEngine = engines.some(e =>
        ['google', 'bing', 'brave'].includes(e)
      );
      expect(hasGeneralEngine).toBe(true);
    });

    it('should return lowercase engine names', () => {
      const engines = getActiveSearxngEngines();
      for (const engine of engines) {
        expect(engine).toBe(engine.toLowerCase());
      }
    });
  });

  describe('validateEngineListConsistency()', () => {
    it('should detect when healthcheck expects different engines than config provides', () => {
      // Create a mismatched expected list
      const wrongExpectedList = ['duckduckgo', 'bing', 'brave']; // includes disabled DuckDuckGo

      const result = validateEngineListConsistency(wrongExpectedList);

      // Should detect that duckduckgo is no longer active
      expect(result.isValid).toBe(false);
      expect(result.extra).toContain('duckduckgo');
    });

    it('should pass when engine lists match', () => {
      // Get actual engines from config
      const actualEngines = getActiveSearxngEngines();

      // Use the actual list as expected
      const result = validateEngineListConsistency(actualEngines);

      expect(result.isValid).toBe(true);
      expect(result.missing).toHaveLength(0);
      expect(result.extra).toHaveLength(0);
    });

    it('should detect missing engines', () => {
      // Create expected list with fewer engines
      const expectedList = ['google']; // Only google

      const result = validateEngineListConsistency(expectedList);

      // Should detect missing engines (e.g., bing if it's active)
      const actualEngines = getActiveSearxngEngines();
      if (actualEngines.length > 1) {
        expect(result.missing.length).toBeGreaterThan(0);
      }
    });
  });

  describe('Configuration Consistency', () => {
    it('healthcheck should have matching engines as the config provides', () => {
      // The healthcheck should be synced with config
      const actualEngines = getActiveSearxngEngines();

      // These are the engines that healthcheck should check for
      // If this test fails, the healthcheck code needs to be updated
      // (or the config has changed and healthcheck wasn't updated)
      expect(actualEngines).toContain('google');
      expect(actualEngines).toContain('bing');
      expect(actualEngines).toContain('brave');
    });

    it('should never have duckduckgo enabled (due to CAPTCHA issues)', () => {
      const engines = getActiveSearxngEngines();
      expect(engines).not.toContain('duckduckgo');
    });
  });
});
