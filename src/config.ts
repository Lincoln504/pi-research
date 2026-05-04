/**
 * Configuration Module
 *
 * Source of truth: .env file in the extension directory.
 * The /research-config TUI is a friendly editor for that file.
 * process.env values override the file (useful for CI / one-off overrides).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from './logger.ts';

// Get the directory where this extension is installed
const __filename = fileURLToPath(import.meta.url);
const EXTENSION_DIR = path.dirname(__filename);

export interface Config {
  /** Per-researcher timeout in milliseconds (default: 360000) */
  RESEARCHER_TIMEOUT_MS: number;
  /** Maximum researchers allowed to run simultaneously (default: 3, max: 5) */
  MAX_CONCURRENT_RESEARCHERS: number;
  /** Maximum retries per researcher request (default: 3) */
  RESEARCHER_MAX_RETRIES: number;
  /** Maximum delay between retries in milliseconds (default: 5000) */
  RESEARCHER_MAX_RETRY_DELAY_MS: number;
  /** Proxy URL for outgoing searches and scraping (optional) */
  PROXY_URL?: string;
  /** Health check timeout in milliseconds (default: 30000) */
  HEALTH_CHECK_TIMEOUT_MS?: number;
  /** Global TUI refresh debounce in milliseconds (default: 10) */
  TUI_REFRESH_DEBOUNCE_MS: number;
  /** Console restore delay after research in milliseconds (default: 15000) */
  CONSOLE_RESTORE_DELAY_MS: number;
  /** Default depth for /research command (0-3, default: 0) */
  DEFAULT_RESEARCH_DEPTH: number;
  /** Maximum scrape batches per researcher (0-16, 0=unlimited, default: 3) */
  MAX_SCRAPE_BATCHES: number;
  /** Number of parallel browser workers for search and scraping (default: 3) */
  WORKER_THREADS: number;
}

export const DEFAULTS: Config = {
  RESEARCHER_TIMEOUT_MS: 360000,
  MAX_CONCURRENT_RESEARCHERS: 3,
  RESEARCHER_MAX_RETRIES: 3,
  RESEARCHER_MAX_RETRY_DELAY_MS: 5000,
  PROXY_URL: undefined,
  HEALTH_CHECK_TIMEOUT_MS: 30000,
  TUI_REFRESH_DEBOUNCE_MS: 10,
  CONSOLE_RESTORE_DELAY_MS: 15000,
  DEFAULT_RESEARCH_DEPTH: 0,
  MAX_SCRAPE_BATCHES: 3,
  WORKER_THREADS: 4,
};

// ============================================================================
// Env-file persistence
// ============================================================================

export function getEnvFilePath(): string {
  return path.join(EXTENSION_DIR, '.env');
}

function parseDotEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1); // preserve value as-is (no extra trim)
    if (key) out[key] = val;
  }
  return out;
}

function loadEnvFile(): Record<string, string> {
  try {
    const p = getEnvFilePath();
    if (fs.existsSync(p)) return parseDotEnv(fs.readFileSync(p, 'utf-8'));
  } catch (err) {
    logger.warn('[config] Failed to read env file:', err);
  }
  return {};
}

/**
 * Write config back to .env in the current directory.
 * Robustly updates existing keys while preserving comments and other variables.
 */
export function saveConfig(config: Config): void {
  const p = getEnvFilePath();
  const newValues: Record<string, string> = {
    PI_RESEARCH_RESEARCHER_TIMEOUT_MS: String(config.RESEARCHER_TIMEOUT_MS),
    PI_RESEARCH_MAX_CONCURRENT_RESEARCHERS: String(config.MAX_CONCURRENT_RESEARCHERS),
    PI_RESEARCH_RESEARCHER_MAX_RETRIES: String(config.RESEARCHER_MAX_RETRIES),
    PI_RESEARCH_RESEARCHER_MAX_RETRY_DELAY_MS: String(config.RESEARCHER_MAX_RETRY_DELAY_MS),
    PI_RESEARCH_HEALTH_CHECK_TIMEOUT_MS: String(config.HEALTH_CHECK_TIMEOUT_MS ?? DEFAULTS.HEALTH_CHECK_TIMEOUT_MS),
    PI_RESEARCH_TUI_REFRESH_DEBOUNCE_MS: String(config.TUI_REFRESH_DEBOUNCE_MS),
    PI_RESEARCH_CONSOLE_RESTORE_DELAY_MS: String(config.CONSOLE_RESTORE_DELAY_MS),
    PI_RESEARCH_DEFAULT_DEPTH: String(config.DEFAULT_RESEARCH_DEPTH),
    PI_RESEARCH_MAX_SCRAPE_BATCHES: String(config.MAX_SCRAPE_BATCHES),
    PI_RESEARCH_WORKER_THREADS: String(config.WORKER_THREADS),
    // Always include PROXY_URL - empty string means "clear this value"
    PROXY_URL: config.PROXY_URL ?? '',
  };

  try {
    let lines: string[] = [];
    if (fs.existsSync(p)) {
      lines = fs.readFileSync(p, 'utf-8').split('\n');
    } else {
      lines = [
        '# pi-research configuration — edit this file or use /research-config in pi',
        '# This file is located in the pi-research extension directory',
        '',
      ];
    }

    const updatedKeys = new Set<string>();
    const outLines: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        outLines.push(line);
        continue;
      }

      const eq = line.indexOf('=');
      if (eq < 1) {
        outLines.push(line);
        continue;
      }

      const key = line.slice(0, eq).trim();
      if (newValues[key] !== undefined) {
        // If new value is empty string, omit the line entirely (clears the value)
        if (newValues[key] !== '') {
          outLines.push(`${key}=${newValues[key]}`);
        }
        updatedKeys.add(key);
      } else {
        outLines.push(line);
      }
    }

    // Add missing keys (skip keys with empty values - they were intentionally cleared)
    let addedAny = false;
    for (const [key, val] of Object.entries(newValues)) {
      if (!updatedKeys.has(key) && val !== '') {
        if (!addedAny && outLines.length > 0 && outLines[outLines.length - 1]?.trim() !== '') {
          outLines.push('');
        }
        outLines.push(`${key}=${val}`);
        addedAny = true;
      }
    }

    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, outLines.join('\n'), 'utf-8');
    logger.info('[config] Saved to', p);
  } catch (err) {
    logger.error('[config] Failed to save config:', err);
    throw err;
  }
}

// ============================================================================
// Parsing helpers
// ============================================================================

function parseEnvNumber(
  env: Record<string, string | undefined>,
  key: string,
  defaultValue: number,
): number {
  const value = env[key];
  if (value === undefined || value === '') return defaultValue;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    logger.warn(`[config] Invalid value for ${key}: "${value}", using default ${defaultValue}`);
    return defaultValue;
  }
  return parsed;
}

function parseEnvString(
  env: Record<string, string | undefined>,
  key: string,
): string | undefined {
  const value = env[key];
  return value === undefined || value === '' ? undefined : value;
}

// ============================================================================
// createConfig
// ============================================================================

/**
 * Build a Config from the env file and environment variables.
 *
 * Priority (highest first):
 *   1. Values in `env` (defaults to process.env) — allows shell / CI overrides
 *   2. Values in <extension-dir>/.env
 *   3. Compiled-in DEFAULTS
 *
 * @param env          Override the env source (pass `{}` in tests).
 * @param fileEnvOverride  Override the file source (pass `{}` in tests to skip file loading).
 */
export function createConfig(
  env: Record<string, string | undefined> = process.env,
  fileEnvOverride?: Record<string, string>,
): Config {
  const fileEnv: Record<string, string | undefined> =
    fileEnvOverride !== undefined ? fileEnvOverride : loadEnvFile();
  // Spread order: file first so that explicit env vars win.
  const e: Record<string, string | undefined> = { ...fileEnv, ...env };

  return {
    RESEARCHER_TIMEOUT_MS: parseEnvNumber(e, 'PI_RESEARCH_RESEARCHER_TIMEOUT_MS', DEFAULTS.RESEARCHER_TIMEOUT_MS),
    MAX_CONCURRENT_RESEARCHERS: parseEnvNumber(e, 'PI_RESEARCH_MAX_CONCURRENT_RESEARCHERS', DEFAULTS.MAX_CONCURRENT_RESEARCHERS),
    RESEARCHER_MAX_RETRIES: parseEnvNumber(e, 'PI_RESEARCH_RESEARCHER_MAX_RETRIES', DEFAULTS.RESEARCHER_MAX_RETRIES),
    RESEARCHER_MAX_RETRY_DELAY_MS: parseEnvNumber(e, 'PI_RESEARCH_RESEARCHER_MAX_RETRY_DELAY_MS', DEFAULTS.RESEARCHER_MAX_RETRY_DELAY_MS),
    PROXY_URL: parseEnvString(e, 'PROXY_URL'),
    HEALTH_CHECK_TIMEOUT_MS: parseEnvNumber(e, 'PI_RESEARCH_HEALTH_CHECK_TIMEOUT_MS', DEFAULTS.HEALTH_CHECK_TIMEOUT_MS as number),
    TUI_REFRESH_DEBOUNCE_MS: parseEnvNumber(e, 'PI_RESEARCH_TUI_REFRESH_DEBOUNCE_MS', DEFAULTS.TUI_REFRESH_DEBOUNCE_MS),
    CONSOLE_RESTORE_DELAY_MS: parseEnvNumber(e, 'PI_RESEARCH_CONSOLE_RESTORE_DELAY_MS', DEFAULTS.CONSOLE_RESTORE_DELAY_MS),
    DEFAULT_RESEARCH_DEPTH: parseEnvNumber(e, 'PI_RESEARCH_DEFAULT_DEPTH', DEFAULTS.DEFAULT_RESEARCH_DEPTH),
    MAX_SCRAPE_BATCHES: parseEnvNumber(e, 'PI_RESEARCH_MAX_SCRAPE_BATCHES', DEFAULTS.MAX_SCRAPE_BATCHES),
    WORKER_THREADS: parseEnvNumber(e, 'PI_RESEARCH_WORKER_THREADS', DEFAULTS.WORKER_THREADS),
  };
}

// ============================================================================
// Global singleton
// ============================================================================

let globalConfig: Config | null = null;

export function getConfig(): Config {
  if (!globalConfig) globalConfig = createConfig();
  return globalConfig;
}

export function setConfig(config: Config): void {
  globalConfig = config;
}

/** Clear the singleton so the next getConfig() re-reads from file. */
export function resetConfig(): void {
  globalConfig = null;
}

// ============================================================================
// Validation
// ============================================================================

export function validateConfig(config: Config = getConfig()): void {
  if (config.RESEARCHER_TIMEOUT_MS < 180000 || config.RESEARCHER_TIMEOUT_MS > 1800000) {
    throw new Error(
      `PI_RESEARCH_RESEARCHER_TIMEOUT_MS must be 180000–1800000ms (3–30 minutes), got ${config.RESEARCHER_TIMEOUT_MS}`,
    );
  }
  if (config.MAX_CONCURRENT_RESEARCHERS < 1 || config.MAX_CONCURRENT_RESEARCHERS > 5) {
    throw new Error(
      `PI_RESEARCH_MAX_CONCURRENT_RESEARCHERS must be 1–5, got ${config.MAX_CONCURRENT_RESEARCHERS}`,
    );
  }
  if (config.RESEARCHER_MAX_RETRIES < 0 || config.RESEARCHER_MAX_RETRIES > 10) {
    throw new Error(
      `PI_RESEARCH_RESEARCHER_MAX_RETRIES must be 0–10, got ${config.RESEARCHER_MAX_RETRIES}`,
    );
  }
  if (config.RESEARCHER_MAX_RETRY_DELAY_MS < 1000 || config.RESEARCHER_MAX_RETRY_DELAY_MS > 60000) {
    throw new Error(
      `PI_RESEARCH_RESEARCHER_MAX_RETRY_DELAY_MS must be 1000–60000ms, got ${config.RESEARCHER_MAX_RETRY_DELAY_MS}`,
    );
  }
  if (config.DEFAULT_RESEARCH_DEPTH < 0 || config.DEFAULT_RESEARCH_DEPTH > 3) {
    throw new Error(
      `PI_RESEARCH_DEFAULT_DEPTH must be 0–3, got ${config.DEFAULT_RESEARCH_DEPTH}`,
    );
  }
  if (config.MAX_SCRAPE_BATCHES < 0 || config.MAX_SCRAPE_BATCHES > 99) {
    throw new Error(
      `PI_RESEARCH_MAX_SCRAPE_BATCHES must be 0–99, got ${config.MAX_SCRAPE_BATCHES}`,
    );
  }
  if (config.WORKER_THREADS < 1 || config.WORKER_THREADS > 16) {
    throw new Error(
      `PI_RESEARCH_WORKER_THREADS must be 1–16, got ${config.WORKER_THREADS}`,
    );
  }
  if (
    config.HEALTH_CHECK_TIMEOUT_MS !== undefined &&
    (config.HEALTH_CHECK_TIMEOUT_MS < 20000 || config.HEALTH_CHECK_TIMEOUT_MS > 120000)
  ) {
    throw new Error(
      `PI_RESEARCH_HEALTH_CHECK_TIMEOUT_MS must be 20000–120000ms, got ${config.HEALTH_CHECK_TIMEOUT_MS}`,
    );
  }
  if (config.PROXY_URL) {
    logger.warn('[config] Proxy configured:', config.PROXY_URL);
  }
}

// ============================================================================
// Backward compatibility
// ============================================================================

/** @deprecated Use getConfig().RESEARCHER_TIMEOUT_MS */
export function getResearcherTimeoutMs(): number { return getConfig().RESEARCHER_TIMEOUT_MS; }
/** @deprecated Use getConfig().PROXY_URL */
export function getProxyUrl(): string | undefined { return getConfig().PROXY_URL; }

export const RESEARCHER_TIMEOUT_MS = getResearcherTimeoutMs();
export const PROXY_URL = getProxyUrl();
