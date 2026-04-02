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
 * @default 60000 (60 seconds)
 * @env PI_RESEARCH_RESEARCHER_TIMEOUT_MS
 */
export const RESEARCHER_TIMEOUT_MS = parseInt(
  process.env['PI_RESEARCH_RESEARCHER_TIMEOUT_MS'] || '60000',
  10
);

/**
 * Flash indicator duration in milliseconds
 * How long the visual flash persists after tool execution
 * @default 1000
 * @env PI_RESEARCH_FLASH_TIMEOUT_MS
 */
export const FLASH_TIMEOUT_MS = parseInt(
  process.env['PI_RESEARCH_FLASH_TIMEOUT_MS'] || '1000',
  10
);

/**
 * Enable Tor proxy for SearXNG searches
 * Uses SOCKS5 proxy to avoid IP blocking
 * @default false
 * @env PI_RESEARCH_ENABLE_TOR
 */
export const ENABLE_TOR = process.env['PI_RESEARCH_ENABLE_TOR'] === 'true';

/**
 * Tor SOCKS5 port
 * @default 9050
 * @env PI_RESEARCH_TOR_SOCKS_PORT
 */
export const TOR_SOCKS_PORT = parseInt(
  process.env['PI_RESEARCH_TOR_SOCKS_PORT'] || '9050',
  10
);

/**
 * Tor control port
 * @default 9051
 * @env PI_RESEARCH_TOR_CONTROL_PORT
 */
export const TOR_CONTROL_PORT = parseInt(
  process.env['PI_RESEARCH_TOR_CONTROL_PORT'] || '9051',
  10
);

/**
 * Auto-start Tor if not running
 * @default false
 * @env PI_RESEARCH_TOR_AUTO_START
 */
export const TOR_AUTO_START = process.env['PI_RESEARCH_TOR_AUTO_START'] === 'true';

/**
 * Validate configuration values
 * @throws {Error} if configuration is invalid
 */
export function validateConfig(): void {
  if (RESEARCHER_TIMEOUT_MS < 5000 || RESEARCHER_TIMEOUT_MS > 600000) {
    throw new Error(
      `PI_RESEARCH_RESEARCHER_TIMEOUT_MS must be between 5000 and 600000 ms, got ${RESEARCHER_TIMEOUT_MS}`
    );
  }

  if (FLASH_TIMEOUT_MS < 100 || FLASH_TIMEOUT_MS > 5000) {
    throw new Error(
      `PI_RESEARCH_FLASH_TIMEOUT_MS must be between 100 and 5000 ms, got ${FLASH_TIMEOUT_MS}`
    );
  }
  if (TOR_SOCKS_PORT < 1024 || TOR_SOCKS_PORT > 65535) {
    throw new Error(
      `PI_RESEARCH_TOR_SOCKS_PORT must be between 1024 and 65535, got ${TOR_SOCKS_PORT}`
    );
  }

  if (TOR_CONTROL_PORT < 1024 || TOR_CONTROL_PORT > 65535) {
    throw new Error(
      `PI_RESEARCH_TOR_CONTROL_PORT must be between 1024 and 65535, got ${TOR_CONTROL_PORT}`
    );
  }

  // Warn if Tor is enabled
  if (ENABLE_TOR) {
    logger.warn('[config] Tor is enabled - searches will be routed through Tor');
  }

  logger.debug('[config] Configuration validated:', {
    RESEARCHER_TIMEOUT_MS,
    FLASH_TIMEOUT_MS,
    ENABLE_TOR,
    TOR_SOCKS_PORT,
    TOR_CONTROL_PORT,
    TOR_AUTO_START,
  });
}
