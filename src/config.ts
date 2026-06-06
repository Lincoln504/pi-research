/**
 * Configuration Module
 *
 * Source of truth: .env file in the extension directory.
 * The /research-config TUI is a friendly editor for that file.
 * process.env values override the file (useful for CI / one-off overrides).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { logger } from './logger.ts';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

// Get the directory where this extension is installed
const __filename = fileURLToPath(import.meta.url);
const EXTENSION_DIR = path.dirname(__filename);

// ============================================================================
// Configuration Schema
// ============================================================================

export const ConfigSchema = Type.Object({
  /** Per-researcher timeout in milliseconds (default: 600000, range: 3-30 minutes) */
  RESEARCHER_TIMEOUT_MS: Type.Number({ minimum: 180000, maximum: 1800000, default: 600000 }),
  /** Maximum researchers to run simultaneously (default: 3, range: 1-5) */
  MAX_CONCURRENT_RESEARCHERS: Type.Number({ minimum: 1, maximum: 5, default: 3 }),
  /** Maximum retries per researcher request (default: 3, range: 0-10) */
  RESEARCHER_MAX_RETRIES: Type.Number({ minimum: 0, maximum: 10, default: 3 }),
  /** Maximum delay between retries in milliseconds (default: 5000, range: 1-60 seconds) */
  RESEARCHER_MAX_RETRY_DELAY_MS: Type.Number({ minimum: 1000, maximum: 60000, default: 5000 }),
  /** Health check timeout in milliseconds (default: 30000, range: 20-120 seconds) */
  HEALTH_CHECK_TIMEOUT_MS: Type.Optional(Type.Number({ minimum: 20000, maximum: 120000, default: 30000 })),
  /** Global TUI refresh debounce in milliseconds (default: 10) */
  TUI_REFRESH_DEBOUNCE_MS: Type.Number({ minimum: 1, default: 10 }),
  /** Console restore delay after research in milliseconds (default: 15000) */
  CONSOLE_RESTORE_DELAY_MS: Type.Number({ minimum: 0, default: 15000 }),
  /** Default depth for /research command (1-3, default: 1) */
  DEFAULT_RESEARCH_DEPTH: Type.Number({ minimum: 1, maximum: 3, default: 1 }),
  /** Maximum scrape batches per researcher (0-99, 0=unlimited, default: 2) */
  MAX_SCRAPE_BATCHES: Type.Number({ minimum: 0, maximum: 99, default: 2 }),
  /** Number of parallel browser workers for search and scraping (default: 4, range: 1-16) */
  WORKER_THREADS: Type.Number({ minimum: 1, maximum: 16, default: 4 }),
  /** Number of concurrent tasks per pool worker process (default: 3, range: 1-10) */
  WORKER_CONCURRENCY: Type.Number({ minimum: 1, maximum: 10, default: 2 }),
  /** Whether the local knowledge store is enabled (default: true) */
  KNOWLEDGE_STORE_ENABLED: Type.Boolean({ default: true }),
  /** Embedding model to use for the knowledge store */
  EMBEDDING_MODEL: Type.String({ default: 'Xenova/all-MiniLM-L6-v2' }),
  /** Inference backend for embeddings: 'webgpu' or 'cpu' */
  EMBEDDING_DEVICE: Type.Union([Type.Literal('webgpu'), Type.Literal('cpu')], { default: 'webgpu' }),
  /** Timeout for scraping operations in milliseconds (default: 15000, range: 5-120 seconds) */
  SCRAPE_TIMEOUT_MS: Type.Number({ minimum: 5000, maximum: 120000, default: 15000 }),
  /** How long to keep cached scrapes in the knowledge store (default: 30 days, range: 1-365) */
  KNOWLEDGE_STORE_CACHE_TTL_DAYS: Type.Number({ minimum: 1, maximum: 365, default: 30 }),
  /** Timeout for embedding model initialization in milliseconds (default: 300000, range: 30s-30min) */
  EMBEDDING_MODEL_INIT_TIMEOUT_MS: Type.Number({ minimum: 30000, maximum: 1800000, default: 300000 }),
  /** Context fraction at which further scraping is blocked (0-1, default: 0.45) */
  MAX_SCRAPE_TOKEN_FRACTION_FOR_SCRAPING: Type.Number({ minimum: 0.0001, maximum: 1, default: 0.45 }),
  /** Estimated tokens consumed by a single scrape batch URL (default: 10000, range: 100-100,000) */
  AVG_TOKENS_PER_SCRAPE: Type.Number({ minimum: 100, maximum: 100000, default: 10000 }),
  /** Maximum concurrent URLs fetched in a single scrape batch (default: 3, range: 1-20) */
  MAX_CONCURRENT_SCRAPES: Type.Number({ minimum: 1, maximum: 20, default: 3 }),
  /** Timeout for a single browser task (search/scrape) in milliseconds (default: 45000) */
  BROWSER_TASK_TIMEOUT_MS: Type.Number({ minimum: 5000, default: 45000 }),
  /** Optional model override for researcher sub-agents. Empty string = use session model. */
  RESEARCH_MODEL: Type.Optional(Type.String({ default: '' })),
  /** Optional directory for the knowledge store */
  KNOWLEDGE_STORE_DIR: Type.Optional(Type.String({ default: '' })),
});

export type Config = Static<typeof ConfigSchema>;

export const DEFAULTS: Config = Value.Create(ConfigSchema);

// ============================================================================
// Env-file persistence
// ============================================================================

export function getEnvFilePath(): string {
  return path.join(EXTENSION_DIR, '.env');
}

export function getDbDir(): string {
  const config = getConfig();

  // 1. Explicit directory override
  if (config.KNOWLEDGE_STORE_DIR) {
    return path.isAbsolute(config.KNOWLEDGE_STORE_DIR) 
      ? config.KNOWLEDGE_STORE_DIR 
      : path.resolve(process.cwd(), config.KNOWLEDGE_STORE_DIR);
  }

  // 2. Local project directory detection
  // If knowledge_db exists in the current project root, use it.
  const localDb = path.resolve(process.cwd(), 'knowledge_db');
  if (fs.existsSync(localDb) && fs.statSync(localDb).isDirectory()) {
    return localDb;
  }

  // 3. Default global directory (in the extension installation folder)
  const dbDir = path.resolve(EXTENSION_DIR, '..', 'knowledge_db');
  // Ensure it's absolute
  return path.isAbsolute(dbDir) ? dbDir : path.resolve(process.cwd(), dbDir);
}

function parseDotEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).replace(/\r$/, ''); // strip Windows \r, preserve leading spaces
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
    PI_RESEARCH_TIMEOUT_MS: String(config.RESEARCHER_TIMEOUT_MS),
    PI_RESEARCH_MAX_RESEARCHERS: String(config.MAX_CONCURRENT_RESEARCHERS),
    PI_RESEARCH_MAX_RETRIES: String(config.RESEARCHER_MAX_RETRIES),
    PI_RESEARCH_RETRY_DELAY_MS: String(config.RESEARCHER_MAX_RETRY_DELAY_MS),
    PI_RESEARCH_HEALTH_CHECK_TIMEOUT_MS: String(config.HEALTH_CHECK_TIMEOUT_MS ?? DEFAULTS.HEALTH_CHECK_TIMEOUT_MS),
    PI_RESEARCH_TUI_REFRESH_DEBOUNCE_MS: String(config.TUI_REFRESH_DEBOUNCE_MS),
    PI_RESEARCH_CONSOLE_RESTORE_DELAY_MS: String(config.CONSOLE_RESTORE_DELAY_MS),
    PI_RESEARCH_DEFAULT_RESEARCH_DEPTH: String(config.DEFAULT_RESEARCH_DEPTH),
    PI_RESEARCH_MAX_SCRAPE_BATCHES: String(config.MAX_SCRAPE_BATCHES),
    PI_RESEARCH_WORKER_THREADS: String(config.WORKER_THREADS),
    PI_RESEARCH_WORKER_CONCURRENCY: String(config.WORKER_CONCURRENCY),
    PI_RESEARCH_KNOWLEDGE_ENABLED: String(config.KNOWLEDGE_STORE_ENABLED),
    PI_RESEARCH_EMBEDDING_MODEL: config.EMBEDDING_MODEL,
    PI_RESEARCH_EMBEDDING_DEVICE: config.EMBEDDING_DEVICE,
    PI_RESEARCH_SCRAPE_TIMEOUT_MS: String(config.SCRAPE_TIMEOUT_MS),
    PI_RESEARCH_CACHE_TTL_DAYS: String(config.KNOWLEDGE_STORE_CACHE_TTL_DAYS),
    PI_RESEARCH_EMBEDDING_MODEL_INIT_TIMEOUT_MS: String(config.EMBEDDING_MODEL_INIT_TIMEOUT_MS),
    PI_RESEARCH_MAX_SCRAPE_TOKEN_FRACTION_FOR_SCRAPING: String(config.MAX_SCRAPE_TOKEN_FRACTION_FOR_SCRAPING),
    PI_RESEARCH_AVG_TOKENS_PER_SCRAPE: String(config.AVG_TOKENS_PER_SCRAPE),
    PI_RESEARCH_MAX_CONCURRENT_SCRAPES: String(config.MAX_CONCURRENT_SCRAPES),
    PI_RESEARCH_BROWSER_TASK_TIMEOUT_MS: String(config.BROWSER_TASK_TIMEOUT_MS),
    PI_RESEARCH_MODEL: config.RESEARCH_MODEL ?? '',
    PI_RESEARCH_KNOWLEDGE_DIR: config.KNOWLEDGE_STORE_DIR ?? '',
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

    const tempPath = `${p}.tmp.${crypto.randomUUID()}`;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(tempPath, outLines.join('\n'), 'utf-8');
    fs.renameSync(tempPath, p);
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

/**
 * Parse an environment variable as a floating-point number.
 * Used for fraction/ratio config values (e.g. 0.45) where parseInt would
 * truncate valid values like "0.7" to 0, causing validation to fail.
 */
function parseEnvFloat(
  env: Record<string, string | undefined>,
  key: string,
  defaultValue: number,
): number {
  const value = env[key];
  if (value === undefined || value === '') return defaultValue;
  const parsed = parseFloat(value);
  if (isNaN(parsed)) {
    logger.warn(`[config] Invalid float for ${key}: "${value}", using default ${defaultValue}`);
    return defaultValue;
  }
  return parsed;
}

function parseEnvString(
  env: Record<string, string | undefined>,
  key: string,
  defaultValue?: string,
): string | undefined {
  const value = env[key];
  return value === undefined || value === '' ? defaultValue : value;
}

function parseEnvBool(
  env: Record<string, string | undefined>,
  key: string,
  defaultValue: boolean,
): boolean {
  const value = env[key];
  if (value === undefined || value === '') return defaultValue;
  const normalized = value.toLowerCase().trim();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  logger.warn(`[config] Invalid boolean for ${key}: "${value}", using default ${defaultValue}`);
  return defaultValue;
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
    RESEARCHER_TIMEOUT_MS: parseEnvNumber(e, 'PI_RESEARCH_TIMEOUT_MS', DEFAULTS.RESEARCHER_TIMEOUT_MS),
    MAX_CONCURRENT_RESEARCHERS: parseEnvNumber(e, 'PI_RESEARCH_MAX_RESEARCHERS', DEFAULTS.MAX_CONCURRENT_RESEARCHERS),
    RESEARCHER_MAX_RETRIES: parseEnvNumber(e, 'PI_RESEARCH_MAX_RETRIES', DEFAULTS.RESEARCHER_MAX_RETRIES),
    RESEARCHER_MAX_RETRY_DELAY_MS: parseEnvNumber(e, 'PI_RESEARCH_RETRY_DELAY_MS', DEFAULTS.RESEARCHER_MAX_RETRY_DELAY_MS),
    HEALTH_CHECK_TIMEOUT_MS: parseEnvNumber(e, 'PI_RESEARCH_HEALTH_CHECK_TIMEOUT_MS', DEFAULTS.HEALTH_CHECK_TIMEOUT_MS as number),
    TUI_REFRESH_DEBOUNCE_MS: parseEnvNumber(e, 'PI_RESEARCH_TUI_REFRESH_DEBOUNCE_MS', DEFAULTS.TUI_REFRESH_DEBOUNCE_MS),
    CONSOLE_RESTORE_DELAY_MS: parseEnvNumber(e, 'PI_RESEARCH_CONSOLE_RESTORE_DELAY_MS', DEFAULTS.CONSOLE_RESTORE_DELAY_MS),
    DEFAULT_RESEARCH_DEPTH: parseEnvNumber(e, 'PI_RESEARCH_DEFAULT_RESEARCH_DEPTH', DEFAULTS.DEFAULT_RESEARCH_DEPTH),
    MAX_SCRAPE_BATCHES: parseEnvNumber(e, 'PI_RESEARCH_MAX_SCRAPE_BATCHES', DEFAULTS.MAX_SCRAPE_BATCHES),
    WORKER_THREADS: parseEnvNumber(e, 'PI_RESEARCH_WORKER_THREADS', DEFAULTS.WORKER_THREADS),
    WORKER_CONCURRENCY: parseEnvNumber(e, 'PI_RESEARCH_WORKER_CONCURRENCY', DEFAULTS.WORKER_CONCURRENCY),
    KNOWLEDGE_STORE_ENABLED: parseEnvBool(e, 'PI_RESEARCH_KNOWLEDGE_ENABLED', DEFAULTS.KNOWLEDGE_STORE_ENABLED),
    EMBEDDING_MODEL: parseEnvString(e, 'PI_RESEARCH_EMBEDDING_MODEL', DEFAULTS.EMBEDDING_MODEL)!,
    EMBEDDING_DEVICE: parseEnvString(e, 'PI_RESEARCH_EMBEDDING_DEVICE', DEFAULTS.EMBEDDING_DEVICE) as 'webgpu' | 'cpu',
    SCRAPE_TIMEOUT_MS: parseEnvNumber(e, 'PI_RESEARCH_SCRAPE_TIMEOUT_MS', DEFAULTS.SCRAPE_TIMEOUT_MS),
    KNOWLEDGE_STORE_CACHE_TTL_DAYS: parseEnvNumber(e, 'PI_RESEARCH_CACHE_TTL_DAYS', DEFAULTS.KNOWLEDGE_STORE_CACHE_TTL_DAYS),
    EMBEDDING_MODEL_INIT_TIMEOUT_MS: parseEnvNumber(e, 'PI_RESEARCH_EMBEDDING_MODEL_INIT_TIMEOUT_MS', DEFAULTS.EMBEDDING_MODEL_INIT_TIMEOUT_MS),
    MAX_SCRAPE_TOKEN_FRACTION_FOR_SCRAPING: parseEnvFloat(e, 'PI_RESEARCH_MAX_SCRAPE_TOKEN_FRACTION_FOR_SCRAPING', DEFAULTS.MAX_SCRAPE_TOKEN_FRACTION_FOR_SCRAPING),
    AVG_TOKENS_PER_SCRAPE: parseEnvNumber(e, 'PI_RESEARCH_AVG_TOKENS_PER_SCRAPE', DEFAULTS.AVG_TOKENS_PER_SCRAPE),
    MAX_CONCURRENT_SCRAPES: parseEnvNumber(e, 'PI_RESEARCH_MAX_CONCURRENT_SCRAPES', DEFAULTS.MAX_CONCURRENT_SCRAPES),
    BROWSER_TASK_TIMEOUT_MS: parseEnvNumber(e, 'PI_RESEARCH_BROWSER_TASK_TIMEOUT_MS', DEFAULTS.BROWSER_TASK_TIMEOUT_MS),
    RESEARCH_MODEL: parseEnvString(e, 'PI_RESEARCH_MODEL', DEFAULTS.RESEARCH_MODEL),
    KNOWLEDGE_STORE_DIR: parseEnvString(e, 'PI_RESEARCH_KNOWLEDGE_DIR', DEFAULTS.KNOWLEDGE_STORE_DIR),
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
  const errors = [...Value.Errors(ConfigSchema, config)];
  if (errors.length > 0) {
    const errorMessages = errors.map(err => `${(err as any).path}: ${err.message}`).join(', ');
    throw new Error(`Invalid configuration: ${errorMessages}`);
  }
}
