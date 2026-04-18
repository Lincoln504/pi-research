/**
 * Configuration Module (Refactored for Testability)
 *
 * Uses factory pattern instead of module-level caching.
 * Allows for different configurations in tests.
 */

import { logger } from './logger.ts';

/**
 * Configuration values
 */
export interface Config {
  /** Per-researcher timeout in milliseconds (default: 240000) */
  RESEARCHER_TIMEOUT_MS: number;
  /** Maximum researchers allowed to run simultaneously (default: 3) */
  MAX_CONCURRENT_RESEARCHERS: number;
  /** Proxy URL for SearXNG searches (optional) */
  PROXY_URL?: string;
  /** Brave Search API key — enables the braveapi engine in SearXNG when set (optional) */
  BRAVE_SEARCH_API_KEY?: string;
  /** Health check timeout in milliseconds (default: 15000) */
  HEALTH_CHECK_TIMEOUT_MS?: number;
  /** Global TUI refresh debounce in milliseconds (default: 10) */
  TUI_REFRESH_DEBOUNCE_MS: number;
  /** Console restore delay after research in milliseconds (default: 15000) */
  CONSOLE_RESTORE_DELAY_MS: number;
  /** BCP 47 language tag sent to SearXNG to filter search results (default: 'en-US') */
  SEARCH_LANGUAGE: string;
}

/**
 * Configuration defaults
 */
const DEFAULTS: Config = {
  RESEARCHER_TIMEOUT_MS: 240000,
  MAX_CONCURRENT_RESEARCHERS: 3,
  PROXY_URL: undefined,
  BRAVE_SEARCH_API_KEY: undefined,
  HEALTH_CHECK_TIMEOUT_MS: 15000,
  TUI_REFRESH_DEBOUNCE_MS: 10,
  CONSOLE_RESTORE_DELAY_MS: 15000,
  SEARCH_LANGUAGE: 'en-US',
};

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
      DEFAULTS.RESEARCHER_TIMEOUT_MS
    ),
    MAX_CONCURRENT_RESEARCHERS: parseEnvNumber(
      env,
      'PI_RESEARCH_MAX_CONCURRENT_RESEARCHERS',
      DEFAULTS.MAX_CONCURRENT_RESEARCHERS
    ),
    PROXY_URL: parseEnvString(env, 'PROXY_URL'),
    BRAVE_SEARCH_API_KEY: parseEnvString(env, 'BRAVE_SEARCH_API_KEY'),
    HEALTH_CHECK_TIMEOUT_MS: parseEnvNumber(
      env,
      'PI_RESEARCH_HEALTH_CHECK_TIMEOUT_MS',
      DEFAULTS.HEALTH_CHECK_TIMEOUT_MS as number,
    ),
    TUI_REFRESH_DEBOUNCE_MS: parseEnvNumber(
      env,
      'PI_RESEARCH_TUI_REFRESH_DEBOUNCE_MS',
      DEFAULTS.TUI_REFRESH_DEBOUNCE_MS
    ),
    CONSOLE_RESTORE_DELAY_MS: parseEnvNumber(
      env,
      'PI_RESEARCH_CONSOLE_RESTORE_DELAY_MS',
      DEFAULTS.CONSOLE_RESTORE_DELAY_MS
    ),
    SEARCH_LANGUAGE: parseEnvString(env, 'PI_RESEARCH_SEARCH_LANGUAGE') ?? DEFAULTS.SEARCH_LANGUAGE,
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

  if (config.MAX_CONCURRENT_RESEARCHERS < 1 || config.MAX_CONCURRENT_RESEARCHERS > 10) {
    throw new Error(
      `PI_RESEARCH_MAX_CONCURRENT_RESEARCHERS must be between 1 and 10, got ${config.MAX_CONCURRENT_RESEARCHERS}`
    );
  }

  // Warn if proxy is configured
  if (config.PROXY_URL) {
    logger.warn('[config] Proxy configured - searches will be routed through:', config.PROXY_URL);
  }

  logger.debug('[config] Configuration validated:', {
    RESEARCHER_TIMEOUT_MS: config.RESEARCHER_TIMEOUT_MS,
    PROXY_URL: config.PROXY_URL,
    HEALTH_CHECK_TIMEOUT_MS: config.HEALTH_CHECK_TIMEOUT_MS,
  });
}

// ============================================================================
// Backward Compatibility Exports
// ============================================================================

/**
 * @deprecated Use getConfig().RESEARCHER_TIMEOUT_MS instead
 * Returns current config value - reflects environment changes if config is reset
 */
export function getResearcherTimeoutMs(): number {
  return getConfig().RESEARCHER_TIMEOUT_MS;
}

/**
 * @deprecated Use getConfig().PROXY_URL instead
 * Returns current config value - reflects environment changes if config is reset
 */
export function getProxyUrl(): string | undefined {
  return getConfig().PROXY_URL;
}

/**
 * @deprecated Use getConfig().BRAVE_SEARCH_API_KEY instead
 */
export function getBraveSearchApiKey(): string | undefined {
  return getConfig().BRAVE_SEARCH_API_KEY;
}

// Legacy variable exports (for backward compatibility, but reflect module load time values)
export const RESEARCHER_TIMEOUT_MS = getResearcherTimeoutMs();
export const PROXY_URL = getProxyUrl();
export const BRAVE_SEARCH_API_KEY = getBraveSearchApiKey();
