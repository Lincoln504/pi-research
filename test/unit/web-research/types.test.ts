/**
 * Web Research Types Unit Tests
 *
 * Tests type exports and constants.
 */

import { describe, it, expect } from 'vitest';

describe('web-research/types', () => {
  describe('constants', () => {
    it('should export PRIMARY_SCRAPER_TIMEOUT constant', () => {
      // Import dynamically to avoid module-level errors
      const types = require('../../../src/web-research/types.ts');
      expect(types.PRIMARY_SCRAPER_TIMEOUT).toBeDefined();
      expect(typeof types.PRIMARY_SCRAPER_TIMEOUT).toBe('number');
    });

    it('should export FALLBACK_SCRAPER_TIMEOUT constant', () => {
      const types = require('../../../src/web-research/types.ts');
      expect(types.FALLBACK_SCRAPER_TIMEOUT).toBeDefined();
      expect(typeof types.FALLBACK_SCRAPER_TIMEOUT).toBe('number');
    });

    it('should have reasonable timeout values', () => {
      const types = require('../../../src/web-research/types.ts');
      expect(types.PRIMARY_SCRAPER_TIMEOUT).toBeGreaterThan(0);
      expect(types.FALLBACK_SCRAPER_TIMEOUT).toBeGreaterThan(0);
      expect(types.FALLBACK_SCRAPER_TIMEOUT).toBeGreaterThanOrEqual(types.PRIMARY_SCRAPER_TIMEOUT);
    });

    it('should have PRIMARY_SCRAPER_TIMEOUT of 15000ms', () => {
      const types = require('../../../src/web-research/types.ts');
      expect(types.PRIMARY_SCRAPER_TIMEOUT).toBe(15000);
    });

    it('should have FALLBACK_SCRAPER_TIMEOUT of 20000ms', () => {
      const types = require('../../../src/web-research/types.ts');
      expect(types.FALLBACK_SCRAPER_TIMEOUT).toBe(20000);
    });
  });
});
