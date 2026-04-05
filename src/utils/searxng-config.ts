/**
 * SearXNG Configuration Loader
 *
 * Reads the SearXNG config YAML and extracts active search engines.
 * Ensures healthcheck and config stay synchronized.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Parse YAML manually (no external dependency)
 * Only extracts the engines section - very targeted parsing
 */
function parseYamlEngines(content: string): Array<{ name: string; disabled?: boolean }> {
  const engines: Array<{ name: string; disabled?: boolean }> = [];

  // Find the engines: section
  const enginesMatch = content.match(/^engines:\s*$/m);
  if (!enginesMatch) {
    logger.warn('[searxng-config] No engines section found in config');
    return engines;
  }

  // Extract lines after "engines:" that are engine definitions
  const enginesStart = enginesMatch.index! + enginesMatch[0].length;
  const remainingContent = content.substring(enginesStart);

  // Split into lines and find engine blocks (lines starting with "  - name:")
  const lines = remainingContent.split('\n');
  let currentEngine: { name: string; disabled?: boolean } | null = null;

  for (const line of lines) {
    // Stop if we hit a non-indented line (next config section)
    if (line && !line.startsWith('  ') && !line.startsWith('\t')) {
      if (currentEngine) {
        engines.push(currentEngine);
      }
      break;
    }

    // Check for engine name
    const nameMatch = line.match(/^\s*- name:\s*(.+)$/);
    if (nameMatch) {
      if (currentEngine) {
        engines.push(currentEngine);
      }
      currentEngine = { name: nameMatch[1].trim() };
      continue;
    }

    // Check for disabled flag
    if (currentEngine && line.match(/^\s*disabled:\s*true\s*$/)) {
      currentEngine.disabled = true;
    }
  }

  // Don't forget the last engine
  if (currentEngine) {
    engines.push(currentEngine);
  }

  return engines;
}

/**
 * Load SearXNG configuration and extract active general search engines
 * Filters out:
 * - Disabled engines
 * - Category-specific engines (images, news, videos)
 * - Category-restricted engines (stackoverflow, arxiv, semantic scholar, etc.)
 * - Encyclopedic engines (wikipedia)
 */
export function getActiveSearxngEngines(): string[] {
  try {
    const configPath = join(__dirname, '../../config/default-settings.yml');
    const content = readFileSync(configPath, 'utf-8');
    const allEngines = parseYamlEngines(content);

    // List of general purpose search engines (whitelist approach is safer)
    const knownGeneralEngines = ['google', 'bing', 'brave', 'startpage', 'mojeek', 'qwant'];

    // Filter for general search engines only
    const activeGeneralEngines = allEngines
      .filter(
        e =>
          !e.disabled && // Not disabled
          knownGeneralEngines.includes(e.name.toLowerCase()) // Only known general engines
      )
      .map(e => e.name.toLowerCase());

    if (activeGeneralEngines.length === 0) {
      logger.warn('[searxng-config] No active general search engines found in config');
    }

    logger.log(`[searxng-config] Active general search engines: [${activeGeneralEngines.join(', ')}]`);
    return activeGeneralEngines;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error('[searxng-config] Failed to load config:', msg);
    // Fallback to known good defaults if config can't be loaded
    return ['google', 'bing', 'brave'];
  }
}

/**
 * Validate that healthcheck engine list matches config
 * Used in tests to catch drift
 */
export function validateEngineListConsistency(expectedEngines: string[]): {
  isValid: boolean;
  missing: string[];
  extra: string[];
} {
  const actualEngines = getActiveSearxngEngines();
  const actualSet = new Set(actualEngines);
  const expectedSet = new Set(expectedEngines);

  const missing = actualEngines.filter(e => !expectedSet.has(e));
  const extra = expectedEngines.filter(e => !actualSet.has(e));

  const isValid = missing.length === 0 && extra.length === 0;

  return {
    isValid,
    missing,
    extra,
  };
}
