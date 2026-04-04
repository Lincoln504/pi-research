/**
 * Configuration Module (Refactored for Testability)
 *
 * Uses factory pattern instead of module-level caching.
 * Allows for different configurations in tests.
 */

import { logger } from './logger.js';

/**
 * Configuration values
 */
export interface Config {
  /** Per-researcher timeout in milliseconds (default: 240000) */
  RESEARCHER_TIMEOUT_MS: number;
  /** Flash indicator duration in milliseconds (default: 1000) */
  FLASH_TIMEOUT_MS: number;
  /** Proxy URL for SearXNG searches (optional) */
  PROXY_URL?: string;
}

/**
 * Configuration defaults
 */
const DEFAULTS: Config = {
  RESEARCHER_TIMEOUT_MS: 240000,
  FLASH_TIMEOUT_MS: 1000,
  PROXY_URL: undefined,
} as const;
/**
 * Parse environment variable to number with default
 */
function parseEnvNumber(
  env: Record<string, string | undefined>,
  key: string,
  defaultValue: number,
  base: number = 10
): number {
  const value = env[key];
  if (value === undefined) {
    return defaultValue;
  }
  const parsed = parseInt(value, base);
  if (isNaN(parsed)) {
    logger.warn(`[config] Invalid value for ${key}, using default: ${defaultValue}`);
    return defaultValue;
  }
  return parsed;
}

/**
 * Get optional string environment variable
 */
function parseEnvString(
  env: Record<string, string | undefined>,
  key: string
): string | undefined {
  const value = env[key];
  return value === undefined ? undefined : value;
}

/**
 * Create configuration from environment variables
 * @param env Optional environment object (for testing)
 * @returns Configuration object
 */
export function createConfig(env: Record<string, string | undefined> = process.env): Config {
  return {
    RESEARCHER_TIMEOUT_MS: parseEnvNumber(
      env,
      'PI_RESEARCH_RESEARCHER_TIMEOUT_MS',
      DEFAULTS.RESEARCHER_TIMEOUT_MS,
      10
    ),
    FLASH_TIMEOUT_MS: parseEnvNumber(
      env,
      'PI_RESEARCH_FLASH_TIMEOUT_MS',
      DEFAULTS.FLASH_TIMEOUT_MS,
      10
    ),
    PROXY_URL: parseEnvString(env, 'PROXY_URL'),
  };
}

/**
 * Global configuration instance (for backward compatibility)
 */
let globalConfig: Config | null = null;

/**
 * Get global configuration
 * Creates from environment if not yet initialized
 */
export function getConfig(): Config {
  if (!globalConfig) {
    globalConfig = createConfig();
  }
  return globalConfig;
}

/**
 * Set global configuration (for testing or manual override)
 */
export function setConfig(config: Config): void {
  globalConfig = config;
}

/**
 * Reset global configuration to environment defaults
 */
export function resetConfig(): void {
  globalConfig = null;
}

/**
 * Validate configuration values
 * @param config Configuration to validate
 * @throws {Error} if configuration is invalid
 */
export function validateConfig(config: Config = getConfig()): void {
  if (config.RESEARCHER_TIMEOUT_MS < 30000 || config.RESEARCHER_TIMEOUT_MS > 600000) {
    throw new Error(
      `PI_RESEARCH_RESEARCHER_TIMEOUT_MS must be between 30000ms (30s) and 600000ms (10m), got ${config.RESEARCHER_TIMEOUT_MS}ms`
    );
  }

  if (config.FLASH_TIMEOUT_MS < 100 || config.FLASH_TIMEOUT_MS > 5000) {
    throw new Error(
      `PI_RESEARCH_FLASH_TIMEOUT_MS must be between 100 and 5000 ms, got ${config.FLASH_TIMEOUT_MS}`
    );
  }

  // Warn if proxy is configured
  if (config.PROXY_URL) {
    logger.warn('[config] Proxy configured - searches will be routed through:', config.PROXY_URL);
  }

  logger.debug('[config] Configuration validated:', {
    RESEARCHER_TIMEOUT_MS: config.RESEARCHER_TIMEOUT_MS,
    FLASH_TIMEOUT_MS: config.FLASH_TIMEOUT_MS,
    PROXY_URL: config.PROXY_URL,
  });
}

// ============================================================================
// Backward Compatibility Exports
// ============================================================================

/**
 * @deprecated Use getConfig() instead
 */
export const RESEARCHER_TIMEOUT_MS = (() => {
  const config = getConfig();
  return config.RESEARCHER_TIMEOUT_MS;
})();

/**
 * @deprecated Use getConfig() instead
 */
export const FLASH_TIMEOUT_MS = (() => {
  const config = getConfig();
  return config.FLASH_TIMEOUT_MS;
})();

/**
 * @deprecated Use getConfig() instead
 */
export const PROXY_URL = (() => {
  const config = getConfig();
  return config.PROXY_URL;
})();
