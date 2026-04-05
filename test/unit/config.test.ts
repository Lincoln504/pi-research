/**
 * Config Module Unit Tests
 *
 * Tests the refactored configuration factory pattern.
 * Now fully testable without module-level caching issues.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createConfig, getConfig, setConfig, resetConfig, validateConfig, type Config } from '../../src/config';

describe('config (refactored)', () => {
  // Clean up global state between tests
  afterEach(() => {
    resetConfig();
  });

  describe('createConfig', () => {
    describe('positive cases', () => {
      it('should use defaults when no environment vars', () => {
        const env = {} as Record<string, string | undefined>;
        const config = createConfig(env);

        expect(config.RESEARCHER_TIMEOUT_MS).toBe(240000);
        expect(config.PROXY_URL).toBeUndefined();
      });

      it('should use custom RESEARCHER_TIMEOUT_MS from env', () => {
        const env = { PI_RESEARCH_RESEARCHER_TIMEOUT_MS: '300000' };
        const config = createConfig(env);

        expect(config.RESEARCHER_TIMEOUT_MS).toBe(300000);
      });

      it('should use custom PROXY_URL from env', () => {
        const env = { PROXY_URL: 'http://proxy.example.com:8080' };
        const config = createConfig(env);

        expect(config.PROXY_URL).toBe('http://proxy.example.com:8080');
      });

      it('should parse all custom values from env', () => {
        const env = {
          PI_RESEARCH_RESEARCHER_TIMEOUT_MS: '180000',
          PROXY_URL: 'socks5://127.0.0.1:9050',
        };
        const config = createConfig(env);

        expect(config.RESEARCHER_TIMEOUT_MS).toBe(180000);
        expect(config.PROXY_URL).toBe('socks5://127.0.0.1:9050');
      });
    });

    describe('negative cases', () => {
      it('should handle invalid RESEARCHER_TIMEOUT_MS string', () => {
        const env = { PI_RESEARCH_RESEARCHER_TIMEOUT_MS: 'invalid' };
        const config = createConfig(env);

        expect(config.RESEARCHER_TIMEOUT_MS).toBe(240000); // Default
      });

      it('should handle empty string values', () => {
        const env = {
          PI_RESEARCH_RESEARCHER_TIMEOUT_MS: '',
          PROXY_URL: '',
        };
        const config = createConfig(env);

        expect(config.RESEARCHER_TIMEOUT_MS).toBe(240000); // Default
        expect(config.PROXY_URL).toBe(''); // Empty string, not undefined
      });

      it('should handle undefined values in env object', () => {
        const env = {
          PI_RESEARCH_RESEARCHER_TIMEOUT_MS: undefined,
          PROXY_URL: undefined,
        };
        const config = createConfig(env);

        expect(config.RESEARCHER_TIMEOUT_MS).toBe(240000); // Default
        expect(config.PROXY_URL).toBeUndefined();
      });
    });

    describe('edge cases', () => {
      it('should handle very large RESEARCHER_TIMEOUT_MS', () => {
        const env = { PI_RESEARCH_RESEARCHER_TIMEOUT_MS: '999999999' };
        const config = createConfig(env);

        expect(config.RESEARCHER_TIMEOUT_MS).toBe(999999999);
      });

      it('should handle very small positive RESEARCHER_TIMEOUT_MS', () => {
        const env = { PI_RESEARCH_RESEARCHER_TIMEOUT_MS: '1' };
        const config = createConfig(env);

        expect(config.RESEARCHER_TIMEOUT_MS).toBe(1);
      });

      it('should handle decimal RESEARCHER_TIMEOUT_MS (parsed as base 10)', () => {
        const env = { PI_RESEARCH_RESEARCHER_TIMEOUT_MS: '180.5' };
        const config = createConfig(env);

        expect(config.RESEARCHER_TIMEOUT_MS).toBe(180); // parseInt floors decimals
      });

      it('should handle proxy URL with special characters', () => {
        const env = { PROXY_URL: 'socks5://user:pass@127.0.0.1:9050' };
        const config = createConfig(env);

        expect(config.PROXY_URL).toBe('socks5://user:pass@127.0.0.1:9050');
      });

      it('should handle unicode in proxy URL', () => {
        const env = { PROXY_URL: 'http://example.com/path/日本語' };
        const config = createConfig(env);

        expect(config.PROXY_URL).toContain('日本語');
      });
    });
  });

  describe('getConfig', () => {
    describe('positive cases', () => {
      it('should return config object', () => {
        const config = getConfig();

        expect(config).toBeDefined();
        expect(typeof config.RESEARCHER_TIMEOUT_MS).toBe('number');
      });

      it('should return same config on subsequent calls', () => {
        const config1 = getConfig();
        const config2 = getConfig();

        expect(config1).toBe(config2); // Same instance
      });

      it('should use process.env by default', () => {
        const config = getConfig();

        expect(config.RESEARCHER_TIMEOUT_MS).toBeGreaterThan(0);
      });
    });

    describe('edge cases', () => {
      it('should create new config if global is reset', () => {
        const config1 = getConfig();
        const config1Value = config1.RESEARCHER_TIMEOUT_MS;

        resetConfig();
        const config2 = getConfig();

        expect(config2).not.toBe(config1); // New instance
        expect(config2.RESEARCHER_TIMEOUT_MS).toBe(config1Value); // Same values
      });
    });
  });

  describe('setConfig', () => {
    describe('positive cases', () => {
      it('should set custom configuration', () => {
        const customConfig: Config = {
          RESEARCHER_TIMEOUT_MS: 180000,
          PROXY_URL: 'http://custom-proxy.com',
        };

        setConfig(customConfig);
        const config = getConfig();

        expect(config.RESEARCHER_TIMEOUT_MS).toBe(180000);
        expect(config.PROXY_URL).toBe('http://custom-proxy.com');
      });

      it('should override existing configuration', () => {
        const config1 = getConfig();
        const originalValue = config1.RESEARCHER_TIMEOUT_MS;

        const customConfig: Config = {
          RESEARCHER_TIMEOUT_MS: 99999,
          PROXY_URL: config1.PROXY_URL,
        };

        setConfig(customConfig);
        const config2 = getConfig();

        expect(config2.RESEARCHER_TIMEOUT_MS).toBe(99999);
        expect(config2.RESEARCHER_TIMEOUT_MS).not.toBe(originalValue);
      });

      it('should persist across multiple getConfig calls', () => {
        const customConfig: Config = {
          RESEARCHER_TIMEOUT_MS: 12345,
        };

        setConfig(customConfig);

        const config1 = getConfig();
        const config2 = getConfig();
        const config3 = getConfig();

        expect(config1.RESEARCHER_TIMEOUT_MS).toBe(12345);
        expect(config2.RESEARCHER_TIMEOUT_MS).toBe(12345);
        expect(config3.RESEARCHER_TIMEOUT_MS).toBe(12345);
      });
    });

    describe('negative cases', () => {
      it('should allow setting invalid values (validated separately)', () => {
        const customConfig: Config = {
          RESEARCHER_TIMEOUT_MS: -1, // Invalid
        };

        expect(() => setConfig(customConfig)).not.toThrow();

        const config = getConfig();
        expect(config.RESEARCHER_TIMEOUT_MS).toBe(-1);
      });
    });
  });

  describe('resetConfig', () => {
    describe('positive cases', () => {
      it('should clear global configuration', () => {
        const customConfig: Config = {
          RESEARCHER_TIMEOUT_MS: 12345,
        };

        setConfig(customConfig);
        expect(getConfig().RESEARCHER_TIMEOUT_MS).toBe(12345);

        resetConfig();
        expect(getConfig().RESEARCHER_TIMEOUT_MS).toBe(240000); // Back to default
      });

      it('should work when no config was set', () => {
        expect(() => resetConfig()).not.toThrow();
        resetConfig();
        resetConfig(); // Multiple resets
      });

      it('should allow new config after reset', () => {
        setConfig({ RESEARCHER_TIMEOUT_MS: 99999 });
        resetConfig();

        const newConfig: Config = {
          RESEARCHER_TIMEOUT_MS: 55555,
        };
        setConfig(newConfig);

        expect(getConfig().RESEARCHER_TIMEOUT_MS).toBe(55555);
      });
    });
  });

  describe('validateConfig', () => {
    describe('positive cases', () => {
      it('should validate default config', () => {
        const config: Config = {
          RESEARCHER_TIMEOUT_MS: 240000,
        };

        expect(() => validateConfig(config)).not.toThrow();
      });

      it('should validate minimum valid values', () => {
        const config: Config = {
          RESEARCHER_TIMEOUT_MS: 30000,
        };

        expect(() => validateConfig(config)).not.toThrow();
      });

      it('should validate maximum valid values', () => {
        const config: Config = {
          RESEARCHER_TIMEOUT_MS: 600000,
        };

        expect(() => validateConfig(config)).not.toThrow();
      });

      it('should validate mid-range values', () => {
        const config: Config = {
          RESEARCHER_TIMEOUT_MS: 180000,
        };

        expect(() => validateConfig(config)).not.toThrow();
      });

      it('should use global config if none provided', () => {
        setConfig({
          RESEARCHER_TIMEOUT_MS: 240000,
        });

        expect(() => validateConfig()).not.toThrow();
      });
    });

    describe('negative cases', () => {
      it('should throw for RESEARCHER_TIMEOUT_MS below minimum', () => {
        const config: Config = {
          RESEARCHER_TIMEOUT_MS: 29999,
        };

        expect(() => validateConfig(config)).toThrow('must be between 30000ms (30s) and 600000ms (10m)');
      });

      it('should throw for RESEARCHER_TIMEOUT_MS above maximum', () => {
        const config: Config = {
          RESEARCHER_TIMEOUT_MS: 600001,
        };

        expect(() => validateConfig(config)).toThrow('must be between 30000ms (30s) and 600000ms (10m)');
      });

      it('should throw for negative RESEARCHER_TIMEOUT_MS', () => {
        const config: Config = {
          RESEARCHER_TIMEOUT_MS: -1,
        };

        expect(() => validateConfig(config)).toThrow('must be between 30000ms (30s) and 600000ms (10m)');
      });

      it('should throw for zero RESEARCHER_TIMEOUT_MS', () => {
        const config: Config = {
          RESEARCHER_TIMEOUT_MS: 0,
        };

        expect(() => validateConfig(config)).toThrow('must be between 30000ms (30s) and 600000ms (10m)');
      });
    });

    describe('edge cases', () => {
      it('should handle boundary values exactly', () => {
        const config1: Config = { RESEARCHER_TIMEOUT_MS: 30000 };
        const config2: Config = { RESEARCHER_TIMEOUT_MS: 600000 };

        expect(() => validateConfig(config1)).not.toThrow();
        expect(() => validateConfig(config2)).not.toThrow();
      });

      it('should handle off-by-one boundary values', () => {
        const config1: Config = { RESEARCHER_TIMEOUT_MS: 29999 };
        const config2: Config = { RESEARCHER_TIMEOUT_MS: 600001 };

        expect(() => validateConfig(config1)).toThrow();
        expect(() => validateConfig(config2)).toThrow();
      });

      it('should handle config with proxy', () => {
        const config: Config = {
          RESEARCHER_TIMEOUT_MS: 240000,
          PROXY_URL: 'http://proxy.example.com:8080',
        };

        expect(() => validateConfig(config)).not.toThrow();
      });
    });
  });

  describe('integration scenarios', () => {
    it('should support full config lifecycle', () => {
      // Start with defaults
      const config1 = getConfig();
      expect(config1.RESEARCHER_TIMEOUT_MS).toBe(240000);

      // Set custom config
      const customConfig: Config = {
        RESEARCHER_TIMEOUT_MS: 180000,
        PROXY_URL: 'http://proxy.com',
      };
      setConfig(customConfig);

      // Verify custom config is used
      const config2 = getConfig();
      expect(config2.RESEARCHER_TIMEOUT_MS).toBe(180000);

      // Validate
      expect(() => validateConfig()).not.toThrow();

      // Reset
      resetConfig();

      // Back to defaults
      const config3 = getConfig();
      expect(config3.RESEARCHER_TIMEOUT_MS).toBe(240000);
    });

    it('should work with test environment', () => {
      const testEnv: Record<string, string | undefined> = {
        PI_RESEARCH_RESEARCHER_TIMEOUT_MS: '120000',
      };

      const config = createConfig(testEnv);
      expect(config.RESEARCHER_TIMEOUT_MS).toBe(120000);

      expect(() => validateConfig(config)).not.toThrow();
    });
  });
});
