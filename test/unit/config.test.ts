/**
 * Config Module Unit Tests
 *
 * Tests the refactored configuration factory pattern.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
vi.mock('../../src/utils/text-utils.ts', () => ({
  normalizeWorkspacePath: vi.fn((p: string) => p),
}));

import { createConfig, getConfig, setConfig, resetConfig, validateConfig, saveConfig, getDbDir, type Config, DEFAULTS } from '../../src/config';
import * as fs from 'node:fs';

// Mock fs to avoid reading .env during tests
vi.mock('node:fs', async () => {
  return {
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => ''),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    copyFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    openSync: vi.fn(() => 42), // Mock file descriptor
    closeSync: vi.fn(),
    statSync: vi.fn(() => ({ mtimeMs: Date.now() })),
  };
});

describe('config (refactored)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Completely clear env vars that we care about
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('PI_RESEARCH_')) {
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

  describe('getDbDir', () => {
    it('returns absolute KNOWLEDGE_STORE_DIR if provided', () => {
      const customDir = '/custom/db/dir';
      setConfig({ KNOWLEDGE_STORE_DIR: customDir });
      expect(getDbDir()).toBe(customDir);
    });

    it('returns default knowledge_db dir if not provided', () => {
      setConfig({ KNOWLEDGE_STORE_DIR: undefined });
      const dir = getDbDir();
      expect(dir).toContain('knowledge_db');
    });
  });

  describe('saveConfig', () => {
    it('should use atomic write via temp file for GLOBAL scope', () => {
      const config = { ...DEFAULTS };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('OLD_KEY=old_val');
      
      saveConfig(config, 'global');

      expect(fs.writeFileSync).toHaveBeenCalledWith(expect.stringContaining('.tmp.'), expect.any(String), 'utf-8');
      expect(fs.renameSync).toHaveBeenCalled();
      // Verify locking
      expect(fs.openSync).toHaveBeenCalledWith(expect.stringContaining('.lock'), 'wx');
      expect(fs.closeSync).toHaveBeenCalledWith(42);
      expect(fs.unlinkSync).toHaveBeenCalledWith(expect.stringContaining('.lock'));
    });

    it('should use centralized registry for LOCAL scope', () => {
      const config = { ...DEFAULTS };
      const cwd = '/test/project';
      vi.mocked(fs.existsSync).mockReturnValue(false);
      
      saveConfig(config, 'local', cwd);

      // Should write to project-settings.json
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('project-settings.json'),
        expect.stringContaining(cwd),
        'utf-8'
      );
    });

    it('should protect against prototype pollution', () => {
      const config = { ...DEFAULTS };
      const writeSpy = vi.spyOn(fs, 'writeFileSync');
      
      saveConfig(config, 'global');

      const writtenContent = writeSpy.mock.calls[0]![1] as string;
      expect(writtenContent).not.toContain('__proto__');
      expect(writtenContent).not.toContain('constructor');
      expect(writtenContent).not.toContain('prototype');
    });

    it('should preserve comments in GLOBAL env file', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('# This is a comment\nPI_RESEARCH_MODEL=old-model');
      
      const config = { ...DEFAULTS, RESEARCH_MODEL: 'new-model' };
      saveConfig(config, 'global');

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0]![1] as string;
      expect(writtenContent).toContain('# This is a comment');
      expect(writtenContent).toContain('PI_RESEARCH_MODEL=new-model');
    });
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
        expect(config.TUI_REFRESH_DEBOUNCE_MS).toBe(DEFAULTS.TUI_REFRESH_DEBOUNCE_MS);
        expect(config.DEFAULT_RESEARCH_DEPTH).toBe(DEFAULTS.DEFAULT_RESEARCH_DEPTH);
        expect(config.WORKER_THREADS).toBe(DEFAULTS.WORKER_THREADS);
      });

      it('should use custom RESEARCHER_TIMEOUT_MS from env', () => {
        const env = { PI_RESEARCH_TIMEOUT_MS: '400000' };
        const config = createConfig(env, {});

        expect(config.RESEARCHER_TIMEOUT_MS).toBe(400000);
      });

      it('should parse custom RESEARCHER_TIMEOUT_MS from env', () => {
        const env = {
          PI_RESEARCH_TIMEOUT_MS: '180000',
        };
        const config = createConfig(env, {});

        expect(config.RESEARCHER_TIMEOUT_MS).toBe(180000);
      });

      it('should parse knowledge store configuration from env', () => {
        const env = {
          PI_RESEARCH_LOCAL_KNOWLEDGE_ENABLED: 'false',
          PI_RESEARCH_GLOBAL_KNOWLEDGE_ENABLED: 'false',
          PI_RESEARCH_EMBEDDING_MODEL: 'custom-model',
          PI_RESEARCH_CACHE_TTL_DAYS: '15',
        };
        const config = createConfig(env, {});

        expect(config.LOCAL_KNOWLEDGE_STORE_ENABLED).toBe(false);
        expect(config.GLOBAL_KNOWLEDGE_STORE_ENABLED).toBe(false);
        expect(config.EMBEDDING_MODEL).toBe('custom-model');
        expect(config.KNOWLEDGE_STORE_CACHE_TTL_DAYS).toBe(15);
      });

      it('should handle boolean variations in env for LOCAL_KNOWLEDGE_STORE_ENABLED', () => {
        expect(createConfig({ PI_RESEARCH_LOCAL_KNOWLEDGE_ENABLED: 'true' }, {}).LOCAL_KNOWLEDGE_STORE_ENABLED).toBe(true);
        expect(createConfig({ PI_RESEARCH_LOCAL_KNOWLEDGE_ENABLED: 'false' }, {}).LOCAL_KNOWLEDGE_STORE_ENABLED).toBe(false);
        expect(createConfig({ PI_RESEARCH_LOCAL_KNOWLEDGE_ENABLED: 'TRUE' }, {}).LOCAL_KNOWLEDGE_STORE_ENABLED).toBe(true);
        expect(createConfig({ PI_RESEARCH_LOCAL_KNOWLEDGE_ENABLED: 'FALSE' }, {}).LOCAL_KNOWLEDGE_STORE_ENABLED).toBe(false);
        expect(createConfig({ PI_RESEARCH_LOCAL_KNOWLEDGE_ENABLED: '' }, {}).LOCAL_KNOWLEDGE_STORE_ENABLED).toBe(false); // default is false for local
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
      expect(() => validateConfig(DEFAULTS)).not.toThrow();
    });

    it('should throw for RESEARCHER_TIMEOUT_MS below minimum (180000)', () => {
      const config = createConfig({ PI_RESEARCH_TIMEOUT_MS: '60000' }, {});
      expect(() => validateConfig(config)).toThrow('must be >= 180000');
    });

    it('should throw for RESEARCHER_TIMEOUT_MS above maximum (1800000)', () => {
      const config = createConfig({ PI_RESEARCH_TIMEOUT_MS: '9999999' }, {});
      expect(() => validateConfig(config)).toThrow('must be <= 1800000');
    });

    it('should throw for MAX_CONCURRENT_RESEARCHERS below 1', () => {
      const config = createConfig({ PI_RESEARCH_MAX_RESEARCHERS: '0' }, {});
      expect(() => validateConfig(config)).toThrow('must be >= 1');
    });

    it('should throw for MAX_CONCURRENT_RESEARCHERS above 5', () => {
      const config = createConfig({ PI_RESEARCH_MAX_RESEARCHERS: '6' }, {});
      expect(() => validateConfig(config)).toThrow('must be <= 5');
    });

    it('should throw for DEFAULT_RESEARCH_DEPTH outside 1–3', () => {
      const low = createConfig({ PI_RESEARCH_DEFAULT_RESEARCH_DEPTH: '0' }, {});
      expect(() => validateConfig(low)).toThrow('must be >= 1');
      const high = createConfig({ PI_RESEARCH_DEFAULT_RESEARCH_DEPTH: '4' }, {});
      expect(() => validateConfig(high)).toThrow('must be <= 3');
    });

    it('should throw for WORKER_CONCURRENCY outside 1–10', () => {
      const low = createConfig({ PI_RESEARCH_WORKER_CONCURRENCY: '0' }, {});
      expect(() => validateConfig(low)).toThrow('must be >= 1');
    });

    it('should throw for EMBEDDING_DEVICE with an unsupported value', () => {
      const config = createConfig({ PI_RESEARCH_EMBEDDING_DEVICE: 'invalid' }, {});
      expect(() => validateConfig(config)).toThrow('must match a schema in anyOf');
    });

    it('should reject EMBEDDING_DEVICE of "cuda"', () => {
      const config = createConfig({ PI_RESEARCH_EMBEDDING_DEVICE: 'cuda' }, {});
      expect(() => validateConfig(config)).toThrow('must match a schema in anyOf');
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
      expect(() => validateConfig(config)).toThrow('must be >= 5000');
    });

    it('should throw for HEALTH_CHECK_TIMEOUT_MS below 2000', () => {
      const config = createConfig({ PI_RESEARCH_HEALTH_CHECK_TIMEOUT_MS: '1000' }, {});
      expect(() => validateConfig(config)).toThrow('must be >= 2000');
    });

    it('should throw for HEALTH_CHECK_TIMEOUT_MS above 120000', () => {
      const config = createConfig({ PI_RESEARCH_HEALTH_CHECK_TIMEOUT_MS: '200000' }, {});
      expect(() => validateConfig(config)).toThrow('must be <= 120000');
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
