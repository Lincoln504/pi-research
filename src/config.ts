/**
 * Configuration Module
 *
 * Externalizes hard-coded values to environment variables with sensible defaults.
 * Allows runtime configuration without code changes.
 */

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
 * @default 500
 * @env PI_RESEARCH_FLASH_TIMEOUT_MS
 */
export const FLASH_TIMEOUT_MS = parseInt(
  process.env['PI_RESEARCH_FLASH_TIMEOUT_MS'] || '500',
  10
);

/**
 * TUI display mode
 * - 'simple': Compact 3-line display (SearXNG status + agents)
 * - 'full': Boxed grid layout with slice/depth hierarchy
 * @default 'simple'
 * @env PI_RESEARCH_TUI_MODE
 */
export const TUI_MODE =
  process.env['PI_RESEARCH_TUI_MODE'] === 'full' ? 'full' : 'simple';

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

  if (TUI_MODE !== 'simple' && TUI_MODE !== 'full') {
    throw new Error(
      `PI_RESEARCH_TUI_MODE must be 'simple' or 'full', got '${TUI_MODE}'`
    );
  }

  console.debug('[config] Configuration validated:', {
    RESEARCHER_TIMEOUT_MS,
    FLASH_TIMEOUT_MS,
    TUI_MODE,
  });
}

/**
 * Log active configuration
 */
export function logConfig(): void {
  console.log('[config] Active configuration:', {
    RESEARCHER_TIMEOUT_MS,
    FLASH_TIMEOUT_MS,
    TUI_MODE,
  });
}
