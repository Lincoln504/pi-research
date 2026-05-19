/**
 * Config Module Unit Tests
 *
 * Tests the refactored configuration factory pattern.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createConfig, getConfig, setConfig, resetConfig, validateConfig, type Config, DEFAULTS } from '../../src/config';

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

        expect(config.RESEARCHER_TIMEOUT_MS).toBe(DEFAULTS.RESEARCHER_TIMEOUT_MS);
        expect(config.MAX_CONCURRENT_RESEARCHERS).toBe(DEFAULTS.MAX_CONCURRENT_RESEARCHERS);
        expect(config.RESEARCHER_MAX_RETRIES).toBe(DEFAULTS.RESEARCHER_MAX_RETRIES);
        expect(config.RESEARCHER_MAX_RETRY_DELAY_MS).toBe(DEFAULTS.RESEARCHER_MAX_RETRY_DELAY_MS);
        expect(config.PROXY_URL).toBe(DEFAULTS.PROXY_URL);
        expect(config.TUI_REFRESH_DEBOUNCE_MS).toBe(DEFAULTS.TUI_REFRESH_DEBOUNCE_MS);
        expect(config.CONSOLE_RESTORE_DELAY_MS).toBe(DEFAULTS.CONSOLE_RESTORE_DELAY_MS);
        expect(config.DEFAULT_RESEARCH_DEPTH).toBe(DEFAULTS.DEFAULT_RESEARCH_DEPTH);
        expect(config.WORKER_THREADS).toBe(DEFAULTS.WORKER_THREADS);
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

      it('should parse knowledge store configuration from env', () => {
        const env = {
          PI_RESEARCH_KNOWLEDGE_STORE_ENABLED: 'false',
          PI_RESEARCH_EMBEDDING_MODEL: 'custom-model',
          PI_RESEARCH_KNOWLEDGE_STORE_CACHE_TTL_DAYS: '15',
        };
        const config = createConfig(env, {});

        expect(config.KNOWLEDGE_STORE_ENABLED).toBe(false);
        expect(config.EMBEDDING_MODEL).toBe('custom-model');
        expect(config.KNOWLEDGE_STORE_CACHE_TTL_DAYS).toBe(15);
      });

      it('should handle boolean variations in env for KNOWLEDGE_STORE_ENABLED', () => {
        expect(createConfig({ PI_RESEARCH_KNOWLEDGE_STORE_ENABLED: 'true' }, {}).KNOWLEDGE_STORE_ENABLED).toBe(true);
        expect(createConfig({ PI_RESEARCH_KNOWLEDGE_STORE_ENABLED: 'false' }, {}).KNOWLEDGE_STORE_ENABLED).toBe(false);
        expect(createConfig({ PI_RESEARCH_KNOWLEDGE_STORE_ENABLED: 'TRUE' }, {}).KNOWLEDGE_STORE_ENABLED).toBe(true);
        expect(createConfig({ PI_RESEARCH_KNOWLEDGE_STORE_ENABLED: 'FALSE' }, {}).KNOWLEDGE_STORE_ENABLED).toBe(false);
        expect(createConfig({ PI_RESEARCH_KNOWLEDGE_STORE_ENABLED: '' }, {}).KNOWLEDGE_STORE_ENABLED).toBe(true); // default
      });
    });
  });

  describe('getConfig', () => {
    it('should return default config if no env', () => {
      const config = getConfig();
      expect(config.RESEARCHER_TIMEOUT_MS).toBe(DEFAULTS.RESEARCHER_TIMEOUT_MS);
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
