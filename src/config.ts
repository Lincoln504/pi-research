/**
 * Configuration Module
 *
 * Source of truth: .env file in the extension directory.
 * The /research-config TUI is a friendly editor for that file.
 * process.env values override the file (useful for CI / one-off overrides).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { logger } from './logger.ts';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { normalizeWorkspacePath } from './utils/text-utils.ts';

/**
 * Validates configuration schema using TypeBox.
 * This provides runtime validation and TypeScript types from the same source.
 */
export const ConfigSchema = Type.Object({
  /** Per-researcher timeout in milliseconds (default: 300000, range: 3-30 min) */
  RESEARCHER_TIMEOUT_MS: Type.Number({ minimum: 180000, maximum: 1800000, default: 300000 }),
  /** Maximum number of concurrent researcher processes (default: 3, range: 1-5) */
  MAX_CONCURRENT_RESEARCHERS: Type.Number({ minimum: 1, maximum: 5, default: 3 }),
  /** Maximum number of retries for a failed researcher (default: 2, range: 0-5) */
  RESEARCHER_MAX_RETRIES: Type.Number({ minimum: 0, maximum: 5, default: 2 }),
  /** Base delay between retries in milliseconds (default: 2000, range: 100-10000) */
  RESEARCHER_MAX_RETRY_DELAY_MS: Type.Number({ minimum: 100, maximum: 10000, default: 2000 }),
  /** Target depth for recursive research (default: 1, range: 1-3) */
  DEFAULT_RESEARCH_DEPTH: Type.Number({ minimum: 1, maximum: 3, default: 1 }),
  /** Number of batches to allow for a single scrape tool call (default: 2, 0=unlimited) */
  MAX_SCRAPE_BATCHES: Type.Number({ minimum: 0, maximum: 99, default: 3 }),
  /** Number of parallel browser pool workers (default: 4, range: 1-10) */
  WORKER_THREADS: Type.Number({ minimum: 1, maximum: 10, default: 4 }),
  /** Number of concurrent tasks per pool worker process (default: 2, range: 1-10) */
  WORKER_CONCURRENCY: Type.Number({ minimum: 1, maximum: 10, default: 2 }),
  /** Whether the local knowledge store is enabled (default: false) */
  LOCAL_KNOWLEDGE_STORE_ENABLED: Type.Boolean({ default: false }),
  /** Whether the global knowledge store is enabled (default: true) */
  GLOBAL_KNOWLEDGE_STORE_ENABLED: Type.Boolean({ default: true }),
  /** Embedding model to use for the knowledge store */
  EMBEDDING_MODEL: Type.String({ default: 'onnx-community/granite-embedding-small-english-r2-ONNX' }),
  /** Hardware backend for embeddings: 'webgpu' or 'cpu' */
  EMBEDDING_DEVICE: Type.Union([Type.Literal('webgpu'), Type.Literal('cpu')], { default: 'webgpu' }),
  /** Timeout for scraping operations in milliseconds (default: 15000, range: 5-120 seconds) */
  SCRAPE_TIMEOUT_MS: Type.Number({ minimum: 5000, maximum: 120000, default: 15000 }),
  /** How long to keep documents in the knowledge store before eviction (default: 30 days) */
  KNOWLEDGE_STORE_CACHE_TTL_DAYS: Type.Number({ minimum: 1, maximum: 365, default: 30 }),
  /** Timeout for embedding model initialization (default: 300000ms) */
  EMBEDDING_MODEL_INIT_TIMEOUT_MS: Type.Number({ minimum: 10000, maximum: 600000, default: 300000 }),
  /** Max fraction of context window to use for initial scrape context (default: 0.15) */
  MAX_SCRAPE_TOKEN_FRACTION_FOR_SCRAPING: Type.Number({ minimum: 0.05, maximum: 1.0, default: 0.15 }),
  /** Estimated tokens per scrape result for planning (default: 2500) */
  AVG_TOKENS_PER_SCRAPE: Type.Number({ minimum: 500, maximum: 10000, default: 2500 }),
  /** Maximum number of concurrent scrapes (default: 3) */
  MAX_CONCURRENT_SCRAPES: Type.Number({ minimum: 1, maximum: 20, default: 3 }),
  /** Health check timeout in milliseconds (default: 10000ms) */
  HEALTH_CHECK_TIMEOUT_MS: Type.Number({ minimum: 2000, maximum: 120000, default: 10000 }),
  /** Default timeout for browser page operations like search (default: 45000ms) */
  SEARCH_TIMEOUT_MS: Type.Number({ minimum: 5000, maximum: 120000, default: 45000 }),
  /** TUI refresh debounce in milliseconds (default: 100ms) */
  TUI_REFRESH_DEBOUNCE_MS: Type.Number({ minimum: 0, maximum: 1000, default: 100 }),
  /** Timeout for individual browser tasks (default: 10000ms) */
  BROWSER_TASK_TIMEOUT_MS: Type.Number({ minimum: 2000, maximum: 120000, default: 10000 }),
  /** Timeout for coordinator/evaluator/repair/knowledge LLM calls in ms (default: 300000 = 5 min, range: 60s-600s).
   *  Not exposed in TUI — controlled via PI_RESEARCH_LLM_TIMEOUT_MS env var. */
  LLM_TIMEOUT_MS: Type.Number({ minimum: 60000, maximum: 600000, default: 300000 }),
  /** LLM Model override for researcher sub-agents and knowledge synthesis.
   *  Format: provider/model-id (e.g. google/gemini-2.0-flash-001) or just model-id.
   *  When set, this overrides ctx.model for researcher sub-agents (both deep and quick)
   *  and the knowledge synthesis background LLM. The coordinator and evaluator always
   *  use the caller's model (ctx.model).
   */
  RESEARCH_MODEL: Type.Optional(Type.String()),
  /** Explicit directory for the knowledge store database (overrides default) */
  KNOWLEDGE_STORE_DIR: Type.Optional(Type.String()),
  /** Whether to automatically export a markdown research report to disk at the end (default: false) */
  RESEARCH_REPORT_EXPORT_ENABLED: Type.Boolean({ default: false }),
  /** Strategy for database schema/model migrations: 'drop', 're-embed', or 'backup' (default: 'backup') */
  MIGRATION_STRATEGY: Type.Union([
    Type.Literal('drop'),
    Type.Literal('re-embed'),
    Type.Literal('backup'),
  ], { default: 'backup' }),
  /** Reasoning/thinking level for researcher agents. (default: 'minimal') */
  THINKING_LEVEL: Type.Union([
    Type.Literal('off'),
    Type.Literal('minimal'),
    Type.Literal('high'),
  ], { default: 'minimal' }),
  /** Whether to mirror logs to the console (stdout/stderr). (default: false) */
  CONSOLE_LOG: Type.Boolean({ default: false }),
  /** Enable debug/verbose logging (writes INFO+DEBUG to log file). (default: true) */
  DEBUG: Type.Boolean({ default: true }),
});

export type Config = Static<typeof ConfigSchema>;

/** Default configuration values extracted from schema */
export const DEFAULTS: Config = Value.Create(ConfigSchema);

// ============================================================================
// Centralized Project Settings Storage
// ============================================================================

/**
 * Returns the path to the centralized project settings file.
 */
export function getProjectSettingsRegistryPath(): string {
  return path.join(os.homedir(), '.pi', 'state', 'project-settings.json');
}

/**
 * Load all project settings from the centralized registry.
 */
function loadProjectSettingsRegistry(): Record<string, Record<string, string>> {
  const registryPath = getProjectSettingsRegistryPath();
  try {
    if (fs.existsSync(registryPath)) {
      const content = fs.readFileSync(registryPath, 'utf-8');
      return JSON.parse(content);
    }
  } catch (err) {
    logger.warn('[config] Failed to read project settings registry:', err);
  }
  return {};
}

/**
 * Internal helper for synchronous sleep without busy-waiting.
 * Uses Atomics.wait which is supported in Node.js main thread.
 */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (_err) {
    // Fallback to busy-wait if SharedArrayBuffer is restricted (unlikely in Node.js)
    const end = Date.now() + ms;
    while (Date.now() < end) { /* spin */ }
  }
}

/**
 * Save the centralized project settings registry.
 */
function saveProjectSettingsRegistry(registry: Record<string, Record<string, string>>): void {
  const registryPath = getProjectSettingsRegistryPath();
  const dir = path.dirname(registryPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  
  const lockPath = `${registryPath}.lock`;
  let lockFd: number | null = null;
  const maxRetries = 100;
  
  try {
    for (let i = 0; i < maxRetries; i++) {
      try {
        lockFd = fs.openSync(lockPath, 'wx');
        break;
      } catch (err: any) {
        if (err.code === 'EEXIST') {
          // Stale lock check
          try {
            const stats = fs.statSync(lockPath);
            if (Date.now() - stats.mtimeMs > 30000) {
              fs.unlinkSync(lockPath);
              continue;
            }
          } catch { /* ignore */ }
          
          sleepSync(50);
          continue;
        }
        throw err;
      }
    }
    
    if (lockFd !== null) {
      fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2), 'utf-8');
    } else {
      throw new Error(`Failed to acquire lock for project settings registry after ${maxRetries} retries. Aborting to prevent data corruption.`);
    }
  } catch (err) {
    logger.error('[config] Failed to save project settings registry:', err);
  } finally {
    if (lockFd !== null) {
      try { fs.closeSync(lockFd); } catch { /* ignore */ }
      try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
    }
  }
}

// ============================================================================
// Env-file persistence
// ============================================================================

/**
 * Returns the global configuration directory (~/.pi/research).
 */
export function getGlobalConfigDir(): string {
  return path.join(os.homedir(), '.pi', 'research');
}

/**
 * Returns the global environment file path (~/.pi/research/config.env).
 */
export function getGlobalEnvFilePath(): string {
  return path.join(getGlobalConfigDir(), 'config.env');
}

/**
 * Returns the local environment file path for a given directory.
 * NOTE: This is now deprecated in favor of centralized storage.
 */
export function getLocalEnvFilePath(cwd: string = process.cwd()): string {
  return path.resolve(cwd, '.pi-research.env');
}

/**
 * Returns the active database directory.
 */
export function getDbDir(config?: Config, cwd: string = process.cwd()): string {
  const cfg = config || getConfig(cwd);
  if (cfg.KNOWLEDGE_STORE_DIR) {
    return path.isAbsolute(cfg.KNOWLEDGE_STORE_DIR) 
      ? cfg.KNOWLEDGE_STORE_DIR 
      : path.resolve(cwd, cfg.KNOWLEDGE_STORE_DIR);
  }
  // Default unified database in the global config directory
  return path.join(getGlobalConfigDir(), 'knowledge_db');
}

function parseDotEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).replace(/\r$/, '');
    if (key) out[key] = val;
  }
  return out;
}

/**
 * Load environment variables from global and local files.
 * Order: Global File < Legacy .env < Centralized Registry (WINS)
 */
function loadEnvFiles(cwd: string): Record<string, string> {
  const merged: Record<string, string> = {};
  const globalPath = getGlobalEnvFilePath();
  const registry = loadProjectSettingsRegistry();
  const normalizedCwd = normalizeWorkspacePath(cwd);
  const homeRegistry = registry[normalizeWorkspacePath(os.homedir())];

  // 1. ONE-TIME MIGRATION: Populate config.env from HOME registry if missing
  try {
    if (!fs.existsSync(globalPath) && homeRegistry && Object.keys(homeRegistry).length > 0) {
      logger.info('[config] config.env missing. Initializing from user settings in central registry...');
      const userLevelKeys = [
        'PI_RESEARCH_EMBEDDING_MODEL', 'PI_RESEARCH_EMBEDDING_DEVICE', 'PI_RESEARCH_EMBEDDING_MODEL_INIT_TIMEOUT_MS',
        'PI_RESEARCH_LOCAL_KNOWLEDGE_ENABLED', 'PI_RESEARCH_GLOBAL_KNOWLEDGE_ENABLED', 'PI_RESEARCH_CACHE_TTL_DAYS',
        'PI_RESEARCH_WORKER_THREADS', 'PI_RESEARCH_WORKER_CONCURRENCY', 'PI_RESEARCH_DEBUG', 'PI_RESEARCH_MODEL',
        'PI_RESEARCH_LLM_TIMEOUT_MS', 'PI_RESEARCH_BROWSER_TASK_TIMEOUT_MS', 'PI_RESEARCH_SCRAPE_TIMEOUT_MS',
        'PI_RESEARCH_SEARCH_TIMEOUT_MS', 'PI_RESEARCH_HEALTH_CHECK_TIMEOUT_MS', 'PI_RESEARCH_REPORT_EXPORT_ENABLED',
        'PI_RESEARCH_AVG_TOKENS_PER_SCRAPE', 'PI_RESEARCH_MAX_SCRAPE_TOKEN_FRACTION_FOR_SCRAPING',
        'PI_RESEARCH_MIGRATION_STRATEGY'
      ];
      const migrated: Record<string, string> = {};
      for (const key of userLevelKeys) {
        if (homeRegistry[key] !== undefined) migrated[key] = homeRegistry[key];
      }
      if (Object.keys(migrated).length > 0) {
        // We use a dummy config to trigger saveConfig('user')
        const dummyConfig = createConfig(migrated, {});
        saveConfig(dummyConfig, 'user', cwd);
      }
    }
  } catch (err) {
    logger.warn('[config] Failed one-time config.env migration:', err);
  }

  // 2. Load Global user config
  try {
    if (fs.existsSync(globalPath)) {
      Object.assign(merged, parseDotEnv(fs.readFileSync(globalPath, 'utf-8')));
    }
  } catch (err) {
    logger.warn('[config] Failed to read global env file:', err);
  }

  // 3. Load Legacy .pi-research.env in CWD
  const legacyPath = getLocalEnvFilePath(cwd);
  let legacyEnv: Record<string, string> = {};
  if (fs.existsSync(legacyPath)) {
    try {
      legacyEnv = parseDotEnv(fs.readFileSync(legacyPath, 'utf-8'));
      Object.assign(merged, legacyEnv);
      
      // Auto-migrate legacy settings to central registry if they differ
      if (!registry[normalizedCwd] || JSON.stringify(registry[normalizedCwd]) !== JSON.stringify(legacyEnv)) {
        logger.info(`[config] Migrating legacy .pi-research.env settings from ${cwd} to central registry...`);
        registry[normalizedCwd] = { ...registry[normalizedCwd], ...legacyEnv };
        saveProjectSettingsRegistry(registry);
      }
    } catch (err) {
      logger.warn(`[config] Failed to load legacy settings for ${cwd}:`, err);
    }
  }

  // 4. Load Centralized project settings (REGISTRY WINS)
  if (registry[normalizedCwd]) {
    // Conflict detection
    for (const [key, val] of Object.entries(registry[normalizedCwd])) {
      if (legacyEnv[key] !== undefined && legacyEnv[key] !== val) {
        logger.warn(`[config] Config divergence for ${key} in ${cwd}: Registry="${val}" vs Legacy="${legacyEnv[key]}". Registry wins.`);
      }
    }
    Object.assign(merged, registry[normalizedCwd]);
  } else if (Object.keys(merged).length === 0 && !fs.existsSync(legacyPath) && !fs.existsSync(globalPath)) {
    // 5. Warning for missing config
    logger.warn(`[config] No configuration found for workspace: ${cwd}. Using code defaults. Run /research-config to configure.`);
  }

  return merged;
}

/**
 * Write config back to env file.
 */
export function saveConfig(config: Config, scope: 'local' | 'global' | 'user' = 'local', cwd: string = process.cwd()): void {
  const newValues: Record<string, string> = {
    PI_RESEARCH_TIMEOUT_MS: String(config.RESEARCHER_TIMEOUT_MS),
    PI_RESEARCH_MAX_RESEARCHERS: String(config.MAX_CONCURRENT_RESEARCHERS),
    PI_RESEARCH_MAX_RETRIES: String(config.RESEARCHER_MAX_RETRIES),
    PI_RESEARCH_RETRY_DELAY_MS: String(config.RESEARCHER_MAX_RETRY_DELAY_MS),
    PI_RESEARCH_HEALTH_CHECK_TIMEOUT_MS: String(config.HEALTH_CHECK_TIMEOUT_MS ?? DEFAULTS.HEALTH_CHECK_TIMEOUT_MS),
    PI_RESEARCH_SEARCH_TIMEOUT_MS: String(config.SEARCH_TIMEOUT_MS),
    PI_RESEARCH_TUI_REFRESH_DEBOUNCE_MS: String(config.TUI_REFRESH_DEBOUNCE_MS),
    PI_RESEARCH_DEFAULT_RESEARCH_DEPTH: String(config.DEFAULT_RESEARCH_DEPTH),
    PI_RESEARCH_MAX_SCRAPE_BATCHES: String(config.MAX_SCRAPE_BATCHES),
    PI_RESEARCH_WORKER_THREADS: String(config.WORKER_THREADS),
    PI_RESEARCH_WORKER_CONCURRENCY: String(config.WORKER_CONCURRENCY),
    PI_RESEARCH_LOCAL_KNOWLEDGE_ENABLED: String(config.LOCAL_KNOWLEDGE_STORE_ENABLED),
    PI_RESEARCH_GLOBAL_KNOWLEDGE_ENABLED: String(config.GLOBAL_KNOWLEDGE_STORE_ENABLED),
    PI_RESEARCH_EMBEDDING_MODEL: config.EMBEDDING_MODEL,
    PI_RESEARCH_EMBEDDING_DEVICE: config.EMBEDDING_DEVICE,
    PI_RESEARCH_SCRAPE_TIMEOUT_MS: String(config.SCRAPE_TIMEOUT_MS),
    PI_RESEARCH_KNOWLEDGE_STORE_CACHE_TTL_DAYS: String(config.KNOWLEDGE_STORE_CACHE_TTL_DAYS),
    PI_RESEARCH_EMBEDDING_MODEL_INIT_TIMEOUT_MS: String(config.EMBEDDING_MODEL_INIT_TIMEOUT_MS),
    PI_RESEARCH_MAX_SCRAPE_TOKEN_FRACTION_FOR_SCRAPING: String(config.MAX_SCRAPE_TOKEN_FRACTION_FOR_SCRAPING),
    PI_RESEARCH_AVG_TOKENS_PER_SCRAPE: String(config.AVG_TOKENS_PER_SCRAPE),
    PI_RESEARCH_MAX_CONCURRENT_SCRAPES: String(config.MAX_CONCURRENT_SCRAPES),
    PI_RESEARCH_BROWSER_TASK_TIMEOUT_MS: String(config.BROWSER_TASK_TIMEOUT_MS),
    PI_RESEARCH_LLM_TIMEOUT_MS: String(config.LLM_TIMEOUT_MS),
    PI_RESEARCH_MIGRATION_STRATEGY: config.MIGRATION_STRATEGY,
    PI_RESEARCH_THINKING_LEVEL: config.THINKING_LEVEL,
    PI_RESEARCH_CONSOLE_LOG: String(config.CONSOLE_LOG),
    ...(config.RESEARCH_MODEL ? { PI_RESEARCH_MODEL: config.RESEARCH_MODEL } : {}),
    ...(config.KNOWLEDGE_STORE_DIR ? { PI_RESEARCH_KNOWLEDGE_DIR: config.KNOWLEDGE_STORE_DIR } : {}),
    PI_RESEARCH_REPORT_EXPORT_ENABLED: String(config.RESEARCH_REPORT_EXPORT_ENABLED),
    PI_RESEARCH_DEBUG: String(config.DEBUG),
  };

  if (scope === 'local') {
    // CENTRALIZED PROJECT STORAGE
    const registry = loadProjectSettingsRegistry();
    const normalizedCwd = normalizeWorkspacePath(cwd);
    registry[normalizedCwd] = newValues;
    saveProjectSettingsRegistry(registry);
    
    logger.debug(`[config] Saved project settings for ${normalizedCwd} to central registry.`);
    return;
  }

  // GLOBAL STORAGE (remains in config.env)
  const p = getGlobalEnvFilePath();
  const lockPath = `${p}.lock`;
  const dir = path.dirname(p);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Simple synchronous file lock
  let lockFd: number | null = null;
  const lockRetryDelay = 50;
  const lockMaxRetries = 100; // 5 seconds total

  for (let i = 0; i < lockMaxRetries; i++) {
    try {
      lockFd = fs.openSync(lockPath, 'wx');
      break;
    } catch (err: any) {
      if (err.code === 'EEXIST') {
        // Check if lock is stale (older than 30s)
        try {
          const stats = fs.statSync(lockPath);
          if (Date.now() - stats.mtimeMs > 30000) {
            fs.unlinkSync(lockPath);
            continue;
          }
        } catch { /* ignore */ }

        const jitter = Math.floor(Math.random() * 20);
        sleepSync(lockRetryDelay + jitter);
        continue;
      }
      throw err;
    }
  }

  if (lockFd === null) {
    throw new Error(`Failed to acquire lock for ${p} after ${lockMaxRetries} retries`);
  }
  
  try {
    let lines: string[] = [];
    if (fs.existsSync(p)) {
      lines = fs.readFileSync(p, 'utf-8').split('\n');
    } else {
      lines = [
        `# pi-research global configuration`,
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
        outLines.push(`${key}=${newValues[key]}`);
        updatedKeys.add(key);
      } else {
        outLines.push(line);
      }
    }

    for (const [key, val] of Object.entries(newValues)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      if (!updatedKeys.has(key) && val !== '') {
        if (outLines.length > 0 && outLines[outLines.length - 1]?.trim() !== '') {
          outLines.push('');
        }
        outLines.push(`${key}=${val}`);
        updatedKeys.add(key);
      }
    }

    // Atomic write
    const tmpPath = `${p}.tmp.${Date.now()}`;
    fs.writeFileSync(tmpPath, outLines.join('\n'), 'utf-8');
    try {
      fs.renameSync(tmpPath, p);
    } catch (renameErr) {
      if (process.platform === 'win32') {
        fs.copyFileSync(tmpPath, p);
        try { fs.unlinkSync(tmpPath); } catch { /* best effort */ }
      } else {
        try { fs.unlinkSync(tmpPath); } catch { /* best effort */ }
        throw renameErr;
      }
    }
  } catch (err) {
    logger.error(`[config] Failed to write config to ${p}:`, err);
    throw err;
  } finally {
    // lockFd is guaranteed non-null here (thrown before try if null)
    fs.closeSync(lockFd!);
    try {
      fs.unlinkSync(lockPath);
    } catch { /* ignore */ }
  }
}

// ============================================================================
// Internal State
// ============================================================================

/**
 * Global singleton for CLI mode. 
 * SDK and OpenClaw should avoid this and use createConfig() or getConfig(cwd).
 */
let globalConfig: Config | null = null;

/**
 * Internal factory for creating a configuration object from env.
 */
export function createConfig(env: Record<string, string | undefined>, processEnv: Record<string, string | undefined>): Config {
  const e = { ...env, ...processEnv };

  const raw = {
    RESEARCHER_TIMEOUT_MS: parseEnvNumber(e, 'PI_RESEARCH_TIMEOUT_MS', DEFAULTS.RESEARCHER_TIMEOUT_MS),
    MAX_CONCURRENT_RESEARCHERS: parseEnvNumber(e, 'PI_RESEARCH_MAX_RESEARCHERS', DEFAULTS.MAX_CONCURRENT_RESEARCHERS),
    RESEARCHER_MAX_RETRIES: parseEnvNumber(e, 'PI_RESEARCH_MAX_RETRIES', DEFAULTS.RESEARCHER_MAX_RETRIES),
    RESEARCHER_MAX_RETRY_DELAY_MS: parseEnvNumber(e, 'PI_RESEARCH_RETRY_DELAY_MS', DEFAULTS.RESEARCHER_MAX_RETRY_DELAY_MS),
    DEFAULT_RESEARCH_DEPTH: parseEnvNumber(e, 'PI_RESEARCH_DEFAULT_RESEARCH_DEPTH', DEFAULTS.DEFAULT_RESEARCH_DEPTH),
    MAX_SCRAPE_BATCHES: parseEnvNumber(e, 'PI_RESEARCH_MAX_SCRAPE_BATCHES', DEFAULTS.MAX_SCRAPE_BATCHES),
    WORKER_THREADS: parseEnvNumber(e, 'PI_RESEARCH_WORKER_THREADS', DEFAULTS.WORKER_THREADS),
    WORKER_CONCURRENCY: parseEnvNumber(e, 'PI_RESEARCH_WORKER_CONCURRENCY', DEFAULTS.WORKER_CONCURRENCY),
    LOCAL_KNOWLEDGE_STORE_ENABLED: parseEnvBool(e, 'PI_RESEARCH_LOCAL_KNOWLEDGE_ENABLED', DEFAULTS.LOCAL_KNOWLEDGE_STORE_ENABLED),
    GLOBAL_KNOWLEDGE_STORE_ENABLED: parseEnvBool(e, 'PI_RESEARCH_GLOBAL_KNOWLEDGE_ENABLED', DEFAULTS.GLOBAL_KNOWLEDGE_STORE_ENABLED),
    EMBEDDING_MODEL: parseEnvString(e, 'PI_RESEARCH_EMBEDDING_MODEL', DEFAULTS.EMBEDDING_MODEL)!,
    EMBEDDING_DEVICE: parseEnvString(e, 'PI_RESEARCH_EMBEDDING_DEVICE', DEFAULTS.EMBEDDING_DEVICE) as 'webgpu' | 'cpu',
    SCRAPE_TIMEOUT_MS: parseEnvNumber(e, 'PI_RESEARCH_SCRAPE_TIMEOUT_MS', DEFAULTS.SCRAPE_TIMEOUT_MS),
    KNOWLEDGE_STORE_CACHE_TTL_DAYS: parseEnvNumber(e, 'PI_RESEARCH_CACHE_TTL_DAYS', DEFAULTS.KNOWLEDGE_STORE_CACHE_TTL_DAYS),
    EMBEDDING_MODEL_INIT_TIMEOUT_MS: parseEnvNumber(e, 'PI_RESEARCH_EMBEDDING_MODEL_INIT_TIMEOUT_MS', DEFAULTS.EMBEDDING_MODEL_INIT_TIMEOUT_MS),
    MAX_SCRAPE_TOKEN_FRACTION_FOR_SCRAPING: parseEnvNumber(e, 'PI_RESEARCH_MAX_SCRAPE_TOKEN_FRACTION_FOR_SCRAPING', DEFAULTS.MAX_SCRAPE_TOKEN_FRACTION_FOR_SCRAPING),
    AVG_TOKENS_PER_SCRAPE: parseEnvNumber(e, 'PI_RESEARCH_AVG_TOKENS_PER_SCRAPE', DEFAULTS.AVG_TOKENS_PER_SCRAPE),
    MAX_CONCURRENT_SCRAPES: parseEnvNumber(e, 'PI_RESEARCH_MAX_CONCURRENT_SCRAPES', DEFAULTS.MAX_CONCURRENT_SCRAPES),
    HEALTH_CHECK_TIMEOUT_MS: parseEnvNumber(e, 'PI_RESEARCH_HEALTH_CHECK_TIMEOUT_MS', DEFAULTS.HEALTH_CHECK_TIMEOUT_MS),
    SEARCH_TIMEOUT_MS: parseEnvNumber(e, 'PI_RESEARCH_SEARCH_TIMEOUT_MS', DEFAULTS.SEARCH_TIMEOUT_MS),
    TUI_REFRESH_DEBOUNCE_MS: parseEnvNumber(e, 'PI_RESEARCH_TUI_REFRESH_DEBOUNCE_MS', DEFAULTS.TUI_REFRESH_DEBOUNCE_MS),
    BROWSER_TASK_TIMEOUT_MS: parseEnvNumber(e, 'PI_RESEARCH_BROWSER_TASK_TIMEOUT_MS', DEFAULTS.BROWSER_TASK_TIMEOUT_MS),
    LLM_TIMEOUT_MS: parseEnvNumber(e, 'PI_RESEARCH_LLM_TIMEOUT_MS', DEFAULTS.LLM_TIMEOUT_MS),
    MIGRATION_STRATEGY: parseEnvString(e, 'PI_RESEARCH_MIGRATION_STRATEGY', DEFAULTS.MIGRATION_STRATEGY) as 'drop' | 're-embed' | 'backup',
    THINKING_LEVEL: parseEnvString(e, 'PI_RESEARCH_THINKING_LEVEL', DEFAULTS.THINKING_LEVEL) as 'off' | 'minimal' | 'high',
    CONSOLE_LOG: parseEnvBool(e, 'PI_RESEARCH_CONSOLE_LOG', DEFAULTS.CONSOLE_LOG),
    RESEARCH_MODEL: parseEnvString(e, 'PI_RESEARCH_MODEL', DEFAULTS.RESEARCH_MODEL),
    KNOWLEDGE_STORE_DIR: parseEnvString(e, 'PI_RESEARCH_KNOWLEDGE_DIR', DEFAULTS.KNOWLEDGE_STORE_DIR),
    RESEARCH_REPORT_EXPORT_ENABLED: parseEnvBool(e, 'PI_RESEARCH_REPORT_EXPORT_ENABLED', DEFAULTS.RESEARCH_REPORT_EXPORT_ENABLED),
    DEBUG: parseEnvBool(e, 'PI_RESEARCH_DEBUG', DEFAULTS.DEBUG),
  };

  const config = { ...DEFAULTS };
  for (const [key, value] of Object.entries(raw)) {
    if (value !== undefined) {
      (config as any)[key] = value;
    }
  }

  // Keep PI_RESEARCH_DEBUG env var in sync with config.DEBUG
  // so that isVerboseFromEnv() (which reads the env var) picks up
  // TUI-configured debug settings without a circular import.
  if (config.DEBUG && processEnv['PI_RESEARCH_DEBUG'] === undefined) {
    processEnv['PI_RESEARCH_DEBUG'] = 'true';
  }

  return config;
}

/**
 * Robustly load configuration for a specific directory.
 * Resolution: Defaults < Global Config (~/.pi/research/config.env) < Local Config (CWD/.pi-research.env) < process.env.
 */
export function getConfig(cwd: string = process.cwd()): Config {
  // If we are in CLI mode (no explicit CWD passed), we can use the global singleton
  // to avoid re-parsing files constantly.
  if (cwd === process.cwd() && globalConfig) {
    return globalConfig;
  }

  const e = loadEnvFiles(cwd);
  const config = createConfig(e, process.env);
  
  if (cwd === process.cwd()) {
    globalConfig = config;
  }
  
  return config;
}

/**
 * Manually override configuration.
 * Mutates the global singleton (for CLI/test compatibility).
 */
export function setConfig(config: Partial<Config>): void {
  const current = getConfig();
  globalConfig = { ...current, ...config };
}

export function resetConfig(): void {
  globalConfig = null;
}

/**
 * Validate configuration object against schema
 */
export function validateConfig(config: Config): void {
  const errors = [...Value.Errors(ConfigSchema, config)];
  if (errors.length > 0) {
    throw new Error(`Invalid configuration: ${errors.map(e => `${(e as any).path || ''} ${e.message}`).join(', ')}`);
  }
}

// Helpers
function parseEnvNumber(env: Record<string, string | undefined>, key: string, def: number): number {
  const v = env[key];
  if (v === undefined || v === '') return def;
  const n = parseFloat(v);
  if (isNaN(n)) {
    logger.warn(`[config] Environment variable ${key}="${v}" is not a valid number, using default: ${def}`);
    return def;
  }
  return n;
}

function parseEnvBool(env: Record<string, string | undefined>, key: string, def: boolean): boolean {
  const v = env[key];
  if (v === undefined || v === '') return def;
  return v.toLowerCase() === 'true';
}

function parseEnvString(env: Record<string, string | undefined>, key: string, def?: string): string | undefined {
  return env[key] || def;
}
