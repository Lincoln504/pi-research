/**
 * Configuration Module
 *
 * Externalizes hard-coded values to environment variables with sensible defaults.
 * Allows runtime configuration without code changes.
 */

import { logger } from './logger.js';

/**
 * Per-researcher timeout in milliseconds
 * Prevents individual researchers from hanging indefinitely
 * Each researcher does 4-5 rounds of searches + 1 batch scrape, which realistically takes 2-4 minutes
 * @default 240000 (4 minutes)
 * @env PI_RESEARCH_RESEARCHER_TIMEOUT_MS
 */
export const RESEARCHER_TIMEOUT_MS = parseInt(
  process.env['PI_RESEARCH_RESEARCHER_TIMEOUT_MS'] || '240000',
  10
);

/**
 * Flash indicator duration in milliseconds
 * How long visual flash persists after tool execution
 * @default 1000
 * @env PI_RESEARCH_FLASH_TIMEOUT_MS
 */
export const FLASH_TIMEOUT_MS = parseInt(
  process.env['PI_RESEARCH_FLASH_TIMEOUT_MS'] || '1000',
  10
);

/**
 * Proxy URL for SearXNG searches (optional)
 * Supports SOCKS5 (Tor) or HTTP/HTTPS proxies
 * Example: socks5://127.0.0.1:9050 or http://proxy.example.com:8080
 * @default undefined (disabled - no proxy)
 * @env PROXY_URL
 */
export const PROXY_URL = process.env['PROXY_URL'];

/**
 * Validate configuration values
 * @throws {Error} if configuration is invalid
 */
export function validateConfig(): void {
  if (RESEARCHER_TIMEOUT_MS < 30000 || RESEARCHER_TIMEOUT_MS > 600000) {
    throw new Error(
      `PI_RESEARCH_RESEARCHER_TIMEOUT_MS must be between 30000ms (30s) and 600000ms (10m), got ${RESEARCHER_TIMEOUT_MS}ms`
    );
  }

  if (FLASH_TIMEOUT_MS < 100 || FLASH_TIMEOUT_MS > 5000) {
    throw new Error(
      `PI_RESEARCH_FLASH_TIMEOUT_MS must be between 100 and 5000 ms, got ${FLASH_TIMEOUT_MS}`
    );
  }

  // Warn if proxy is configured
  if (PROXY_URL) {
    logger.warn('[config] Proxy configured - searches will be routed through:', PROXY_URL);
  }

  logger.debug('[config] Configuration validated:', {
    RESEARCHER_TIMEOUT_MS,
    FLASH_TIMEOUT_MS,
    PROXY_URL,
  });
}
