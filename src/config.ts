/**
 * Configuration Module
 *
 * Centralized configuration management for pi-research.
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
  /** Maximum retries per researcher request (default: 3) */
  RESEARCHER_MAX_RETRIES: number;
  /** Maximum delay between retries in milliseconds (default: 5000) */
  RESEARCHER_MAX_RETRY_DELAY_MS: number;
  /** Proxy URL for outgoing searches and scraping (optional) */
  PROXY_URL?: string;
  /** Health check timeout in milliseconds (default: 60000) */
  HEALTH_CHECK_TIMEOUT_MS?: number;
  /** Global TUI refresh debounce in milliseconds (default: 10) */
  TUI_REFRESH_DEBOUNCE_MS: number;
  /** Console restore delay after research in milliseconds (default: 15000) */
  CONSOLE_RESTORE_DELAY_MS: number;
  /** Default depth for /research command (0-3, default: 0) */
  DEFAULT_RESEARCH_DEPTH: number;
}

/**
 * Configuration defaults
 */
const DEFAULTS: Config = {
  RESEARCHER_TIMEOUT_MS: 360000,
  MAX_CONCURRENT_RESEARCHERS: 3,
  RESEARCHER_MAX_RETRIES: 3,
  RESEARCHER_MAX_RETRY_DELAY_MS: 5000,
  PROXY_URL: undefined,
  HEALTH_CHECK_TIMEOUT_MS: 60000,
  TUI_REFRESH_DEBOUNCE_MS: 10,
  CONSOLE_RESTORE_DELAY_MS: 15000,
  DEFAULT_RESEARCH_DEPTH: 0,
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
    RESEARCHER_MAX_RETRIES: parseEnvNumber(
      env,
      'PI_RESEARCH_RESEARCHER_MAX_RETRIES',
      DEFAULTS.RESEARCHER_MAX_RETRIES
    ),
    RESEARCHER_MAX_RETRY_DELAY_MS: parseEnvNumber(
      env,
      'PI_RESEARCH_RESEARCHER_MAX_RETRY_DELAY_MS',
      DEFAULTS.RESEARCHER_MAX_RETRY_DELAY_MS
    ),
    PROXY_URL: parseEnvString(env, 'PROXY_URL'),
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
    DEFAULT_RESEARCH_DEPTH: parseEnvNumber(
      env,
      'PI_RESEARCH_DEFAULT_DEPTH',
      DEFAULTS.DEFAULT_RESEARCH_DEPTH
    ),
  };
}

/**
 * Global configuration instance
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

  if (config.RESEARCHER_MAX_RETRIES < 0 || config.RESEARCHER_MAX_RETRIES > 10) {
    throw new Error(
      `PI_RESEARCH_RESEARCHER_MAX_RETRIES must be between 0 and 10, got ${config.RESEARCHER_MAX_RETRIES}`
    );
  }

  if (config.RESEARCHER_MAX_RETRY_DELAY_MS < 1000 || config.RESEARCHER_MAX_RETRY_DELAY_MS > 60000) {
    throw new Error(
      `PI_RESEARCH_RESEARCHER_MAX_RETRY_DELAY_MS must be between 1000ms (1s) and 60000ms (60s), got ${config.RESEARCHER_MAX_RETRY_DELAY_MS}ms`
    );
  }

  if (config.DEFAULT_RESEARCH_DEPTH < 0 || config.DEFAULT_RESEARCH_DEPTH > 3) {
    throw new Error(
      `PI_RESEARCH_DEFAULT_DEPTH must be between 0 and 3, got ${config.DEFAULT_RESEARCH_DEPTH}`
    );
  }

  if (config.HEALTH_CHECK_TIMEOUT_MS !== undefined && (config.HEALTH_CHECK_TIMEOUT_MS < 20000 || config.HEALTH_CHECK_TIMEOUT_MS > 120000)) {
    throw new Error(
      `PI_RESEARCH_HEALTH_CHECK_TIMEOUT_MS must be between 20000ms (20s) and 120000ms (2m), got ${config.HEALTH_CHECK_TIMEOUT_MS}ms`
    );
  }

  // Warn if proxy is configured
  if (config.PROXY_URL) {
    logger.warn('[config] Proxy configured - research will be routed through:', config.PROXY_URL);
  }

  logger.debug('[config] Configuration validated:', {
    RESEARCHER_TIMEOUT_MS: config.RESEARCHER_TIMEOUT_MS,
    MAX_CONCURRENT_RESEARCHERS: config.MAX_CONCURRENT_RESEARCHERS,
    RESEARCHER_MAX_RETRIES: config.RESEARCHER_MAX_RETRIES,
    RESEARCHER_MAX_RETRY_DELAY_MS: config.RESEARCHER_MAX_RETRY_DELAY_MS,
    PROXY_URL: config.PROXY_URL,
    HEALTH_CHECK_TIMEOUT_MS: config.HEALTH_CHECK_TIMEOUT_MS,
    DEFAULT_RESEARCH_DEPTH: config.DEFAULT_RESEARCH_DEPTH,
  });
}

// ============================================================================
// Backward Compatibility Exports
// ============================================================================

/** @deprecated Use getConfig().RESEARCHER_TIMEOUT_MS */
export function getResearcherTimeoutMs(): number { return getConfig().RESEARCHER_TIMEOUT_MS; }
/** @deprecated Use getConfig().PROXY_URL */
export function getProxyUrl(): string | undefined { return getConfig().PROXY_URL; }

export const RESEARCHER_TIMEOUT_MS = getResearcherTimeoutMs();
export const PROXY_URL = getProxyUrl();
