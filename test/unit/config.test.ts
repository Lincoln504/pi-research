/**
 * Config Module Unit Tests
 *
 * Tests the refactored configuration factory pattern.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createConfig, getConfig, setConfig, resetConfig, validateConfig, type Config } from '../../src/config';

// Mock fs to avoid reading .env during tests
vi.mock('node:fs', async () => {
  return {
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => ''),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

describe('config (refactored)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Completely clear env vars that we care about
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('PI_RESEARCH_') || key === 'PROXY_URL') {
        delete process.env[key];
      }
    }
    resetConfig();
  });

  // Clean up global state between tests
  afterEach(() => {
    resetConfig();
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  describe('createConfig', () => {
    describe('positive cases', () => {
      it('should use defaults when no environment vars', () => {
        const env = {} as Record<string, string | undefined>;
        const config = createConfig(env, {});

        expect(config.RESEARCHER_TIMEOUT_MS).toBe(360000);
        expect(config.MAX_CONCURRENT_RESEARCHERS).toBe(3);
        expect(config.RESEARCHER_MAX_RETRIES).toBe(3);
        expect(config.RESEARCHER_MAX_RETRY_DELAY_MS).toBe(5000);
        expect(config.PROXY_URL).toBeUndefined();
        expect(config.TUI_REFRESH_DEBOUNCE_MS).toBe(10);
        expect(config.CONSOLE_RESTORE_DELAY_MS).toBe(15000);
        expect(config.DEFAULT_RESEARCH_DEPTH).toBe(0);
        expect(config.WORKER_THREADS).toBe(4);
      });

      it('should use custom RESEARCHER_TIMEOUT_MS from env', () => {
        const env = { PI_RESEARCH_RESEARCHER_TIMEOUT_MS: '400000' };
        const config = createConfig(env, {});

        expect(config.RESEARCHER_TIMEOUT_MS).toBe(400000);
      });

      it('should parse all custom values from env', () => {
        const env = {
          PI_RESEARCH_RESEARCHER_TIMEOUT_MS: '180000',
          PROXY_URL: 'socks5://127.0.0.1:9050',
        };
        const config = createConfig(env, {});

        expect(config.RESEARCHER_TIMEOUT_MS).toBe(180000);
        expect(config.PROXY_URL).toBe('socks5://127.0.0.1:9050');
      });
    });
  });

  describe('getConfig', () => {
    it('should return default config if no env', () => {
      const config = getConfig();
      expect(config.RESEARCHER_TIMEOUT_MS).toBe(360000);
    });
  });

  describe('validateConfig', () => {
    it('should validate default config', () => {
      expect(() => validateConfig()).not.toThrow();
    });

    it('should throw for RESEARCHER_TIMEOUT_MS below minimum', () => {
      const config = createConfig({ PI_RESEARCH_RESEARCHER_TIMEOUT_MS: '60000' }, {});
      expect(() => validateConfig(config)).toThrow('must be 180000–1800000ms');
    });
  });
});
