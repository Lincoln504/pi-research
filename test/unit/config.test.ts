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
        const env = { PI_RESEARCH_TIMEOUT_MS: '400000' };
        const config = createConfig(env, {});

        expect(config.RESEARCHER_TIMEOUT_MS).toBe(400000);
      });

      it('should parse all custom values from env', () => {
        const env = {
          PI_RESEARCH_TIMEOUT_MS: '180000',
          PROXY_URL: 'socks5://127.0.0.1:9050',
        };
        const config = createConfig(env, {});

        expect(config.RESEARCHER_TIMEOUT_MS).toBe(180000);
        expect(config.PROXY_URL).toBe('socks5://127.0.0.1:9050');
      });

      it('should parse knowledge store configuration from env', () => {
        const env = {
          PI_RESEARCH_KNOWLEDGE_ENABLED: 'false',
          PI_RESEARCH_EMBEDDING_MODEL: 'custom-model',
          PI_RESEARCH_CACHE_TTL_DAYS: '15',
        };
        const config = createConfig(env, {});

        expect(config.KNOWLEDGE_STORE_ENABLED).toBe(false);
        expect(config.EMBEDDING_MODEL).toBe('custom-model');
        expect(config.KNOWLEDGE_STORE_CACHE_TTL_DAYS).toBe(15);
      });

      it('should handle boolean variations in env for KNOWLEDGE_STORE_ENABLED', () => {
        expect(createConfig({ PI_RESEARCH_KNOWLEDGE_ENABLED: 'true' }, {}).KNOWLEDGE_STORE_ENABLED).toBe(true);
        expect(createConfig({ PI_RESEARCH_KNOWLEDGE_ENABLED: 'false' }, {}).KNOWLEDGE_STORE_ENABLED).toBe(false);
        expect(createConfig({ PI_RESEARCH_KNOWLEDGE_ENABLED: 'TRUE' }, {}).KNOWLEDGE_STORE_ENABLED).toBe(true);
        expect(createConfig({ PI_RESEARCH_KNOWLEDGE_ENABLED: 'FALSE' }, {}).KNOWLEDGE_STORE_ENABLED).toBe(false);
        expect(createConfig({ PI_RESEARCH_KNOWLEDGE_ENABLED: '' }, {}).KNOWLEDGE_STORE_ENABLED).toBe(true); // default
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
    it('should validate default config without throwing', () => {
      expect(() => validateConfig()).not.toThrow();
    });

    it('should throw for RESEARCHER_TIMEOUT_MS below minimum (180000)', () => {
      const config = createConfig({ PI_RESEARCH_TIMEOUT_MS: '60000' }, {});
      expect(() => validateConfig(config)).toThrow('180000–1800000ms');
    });

    it('should throw for RESEARCHER_TIMEOUT_MS above maximum (1800000)', () => {
      const config = createConfig({ PI_RESEARCH_TIMEOUT_MS: '9999999' }, {});
      expect(() => validateConfig(config)).toThrow('180000–1800000ms');
    });

    it('should throw for MAX_CONCURRENT_RESEARCHERS below 1', () => {
      const config = createConfig({ PI_RESEARCH_MAX_RESEARCHERS: '0' }, {});
      expect(() => validateConfig(config)).toThrow('1–5');
    });

    it('should throw for MAX_CONCURRENT_RESEARCHERS above 5', () => {
      const config = createConfig({ PI_RESEARCH_MAX_RESEARCHERS: '6' }, {});
      expect(() => validateConfig(config)).toThrow('1–5');
    });

    it('should throw for DEFAULT_RESEARCH_DEPTH outside 1–3', () => {
      const low = createConfig({ PI_RESEARCH_DEFAULT_RESEARCH_DEPTH: '0' }, {});
      expect(() => validateConfig(low)).toThrow('1–3');
      const high = createConfig({ PI_RESEARCH_DEFAULT_RESEARCH_DEPTH: '4' }, {});
      expect(() => validateConfig(high)).toThrow('1–3');
    });

    it('should throw for WORKER_CONCURRENCY outside 1–10', () => {
      const low = createConfig({ PI_RESEARCH_WORKER_CONCURRENCY: '0' }, {});
      expect(() => validateConfig(low)).toThrow('1–10');
    });

    it('should throw for EMBEDDING_DEVICE with an unsupported value', () => {
      const config = createConfig({ PI_RESEARCH_EMBEDDING_DEVICE: 'invalid' }, {});
      expect(() => validateConfig(config)).toThrow('webgpu, cpu');
    });

    it('should reject EMBEDDING_DEVICE of "cuda"', () => {
      const config = createConfig({ PI_RESEARCH_EMBEDDING_DEVICE: 'cuda' }, {});
      expect(() => validateConfig(config)).toThrow('webgpu, cpu');
    });

    it('should accept EMBEDDING_DEVICE of "webgpu"', () => {
      const config = createConfig({ PI_RESEARCH_EMBEDDING_DEVICE: 'webgpu' }, {});
      expect(() => validateConfig(config)).not.toThrow();
    });

    it('should accept EMBEDDING_DEVICE of "cpu"', () => {
      const config = createConfig({ PI_RESEARCH_EMBEDDING_DEVICE: 'cpu' }, {});
      expect(() => validateConfig(config)).not.toThrow();
    });

    it('should throw for SCRAPE_TIMEOUT_MS below minimum', () => {
      const config = createConfig({ PI_RESEARCH_SCRAPE_TIMEOUT_MS: '1000' }, {});
      expect(() => validateConfig(config)).toThrow('5000–120000');
    });

    it('should throw for HEALTH_CHECK_TIMEOUT_MS below 20000', () => {
      const config = createConfig({ PI_RESEARCH_HEALTH_CHECK_TIMEOUT_MS: '5000' }, {});
      expect(() => validateConfig(config)).toThrow('20000–120000ms');
    });

    it('should throw for HEALTH_CHECK_TIMEOUT_MS above 120000', () => {
      const config = createConfig({ PI_RESEARCH_HEALTH_CHECK_TIMEOUT_MS: '200000' }, {});
      expect(() => validateConfig(config)).toThrow('20000–120000ms');
    });
  });

  describe('setConfig / resetConfig', () => {
    it('setConfig persists and getConfig returns the new value', () => {
      const config = createConfig({ PI_RESEARCH_TIMEOUT_MS: '300000' }, {});
      setConfig(config);
      expect(getConfig().RESEARCHER_TIMEOUT_MS).toBe(300000);
    });

    it('resetConfig causes getConfig to re-read defaults from env', () => {
      const config = createConfig({ PI_RESEARCH_TIMEOUT_MS: '300000' }, {});
      setConfig(config);
      resetConfig();
      // After reset, getConfig() rebuilds from env (cleared in beforeEach), giving defaults
      expect(getConfig().RESEARCHER_TIMEOUT_MS).toBe(DEFAULTS.RESEARCHER_TIMEOUT_MS);
    });
  });

  describe('env parsing edge cases', () => {
    it('ignores non-numeric values for numeric fields and uses defaults', () => {
      // createConfig uses parseInt which returns NaN for non-numeric strings;
      // parseEnvNumber falls back to the default value
      const config = createConfig({ PI_RESEARCH_TIMEOUT_MS: 'not-a-number' }, {});
      expect(config.RESEARCHER_TIMEOUT_MS).toBe(DEFAULTS.RESEARCHER_TIMEOUT_MS);
    });

    it('parses the minimum-valid RESEARCHER_TIMEOUT_MS (180000) without error', () => {
      const config = createConfig({ PI_RESEARCH_TIMEOUT_MS: '180000' }, {});
      expect(() => validateConfig(config)).not.toThrow();
      expect(config.RESEARCHER_TIMEOUT_MS).toBe(180000);
    });

    it('parses the maximum-valid RESEARCHER_TIMEOUT_MS (1800000) without error', () => {
      const config = createConfig({ PI_RESEARCH_TIMEOUT_MS: '1800000' }, {});
      expect(() => validateConfig(config)).not.toThrow();
      expect(config.RESEARCHER_TIMEOUT_MS).toBe(1800000);
    });
  });
});
