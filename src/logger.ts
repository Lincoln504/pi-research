/**
 * Logger — scoped file-based diagnostics
 *
 * Silent by default. When --verbose or PI_RESEARCH_VERBOSE=1 is set,
 * writes timestamped lines to {tmpdir}/pi-research-debug-{hash}.log where {hash}
 * is a random 4-character alphanumeric suffix (a-z, 0-9) to keep logs separate per run.
 *
 * When NOT verbose: logFile is null, preventing all temp-dir writes.
 * This module never patches process-global console.* methods.
 */

import { appendFileSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Log level enum
 */
export enum LogLevel {
  INFO = 'INFO',
  ERROR = 'ERROR',
  WARN = 'WARN',
  DEBUG = 'DEBUG',
}

/**
 * Logger interface for dependency injection
 */
export interface ILogger {
  log(...args: unknown[]): void;
  info(...args: unknown[]): void;
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}

/**
 * Logger configuration options
 */
export interface LoggerOptions {
  verbose: boolean;
  logFilePath?: string;
}

export interface LogContext {
  sessionId?: string;
  sessionFile?: string;
  cwd?: string;
  researchRunId?: string;
  toolName?: string;
  phase?: string;
  eventName?: string;
}

const logContextStorage = new AsyncLocalStorage<LogContext>();

/**
 * Generate a 4-character alphanumeric hash for uniqueness
 */
function generateHash(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let hash = '';
  for (let i = 0; i < 4; i++) {
    hash += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return hash;
}

function buildDefaultDebugLogPath(hash: string): string {
  return path.join(os.tmpdir(), `pi-research-debug-${hash}.log`);
}

export function getDefaultDebugLogPathTemplate(): string {
  return buildDefaultDebugLogPath('{hash}');
}

/**
 * Check if verbose mode is enabled from environment
 */
export function isVerboseFromEnv(): boolean {
  return process.argv.includes('--verbose') || process.env['PI_RESEARCH_VERBOSE'] === '1';
}

export function createResearchRunId(): string {
  return `run-${randomBytes(4).toString('hex')}`;
}

export function getLogContext(): LogContext {
  return logContextStorage.getStore() ?? {};
}

export function runWithLogContext<T>(context: LogContext, callback: () => T): T {
  const parent = logContextStorage.getStore() ?? {};
  return logContextStorage.run({ ...parent, ...context }, callback);
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 0);
  } catch {
    return '[unserializable]';
  }
}

function formatArg(arg: unknown): string {
  if (arg instanceof Error) {
    return arg.stack ?? arg.message;
  }
  if (typeof arg === 'object' && arg !== null) {
    return safeJsonStringify(arg);
  }
  return String(arg);
}

/**
 * Logger implementation — writes to file when verbose, silent otherwise
 */
export class Logger implements ILogger {
  private verbose: boolean;
  private logFile: string | null;

  constructor(options: Partial<LoggerOptions> = {}) {
    this.verbose = options.verbose ?? isVerboseFromEnv();
    // Only set logFile path if verbose mode is enabled
    if (this.verbose) {
      const hash = generateHash();
      this.logFile = options.logFilePath ?? buildDefaultDebugLogPath(hash);
    } else {
      this.logFile = null;
    }
  }

  /**
   * Emit a log message to file (if verbose) or nowhere (if silent)
   * @param level - Log level (INFO, ERROR, WARN, DEBUG)
   * @param args - Arguments to log
   */
  private emit(level: string, ...args: unknown[]): void {
    if (!this.verbose || !this.logFile) {
      return;
    }

    const timestamp = new Date().toISOString();
    const firstError = args.find((arg): arg is Error => arg instanceof Error);
    const entry = {
      timestamp,
      level,
      ...getLogContext(),
      message: args.map(formatArg).join(' '),
      ...(firstError
        ? { errorMessage: firstError.message, errorStack: firstError.stack }
        : {}),
    };
    const line = `${safeJsonStringify(entry)}\n`;

    // Write to file
    try {
      appendFileSync(this.logFile, line);
    } catch {
      // Silently ignore file write errors
    }
  }

  log(...args: unknown[]): void {
    this.emit(LogLevel.INFO, ...args);
  }

  info(...args: unknown[]): void {
    this.emit(LogLevel.INFO, ...args);
  }

  error(...args: unknown[]): void {
    this.emit(LogLevel.ERROR, ...args);
  }

  warn(...args: unknown[]): void {
    this.emit(LogLevel.WARN, ...args);
  }

  debug(...args: unknown[]): void {
    this.emit(LogLevel.DEBUG, ...args);
  }

  /**
   * Get the log file path
   */
  getLogFilePath(): string | null {
    return this.logFile;
  }

  /**
   * Check if verbose mode is enabled
   */
  isVerbose(): boolean {
    return this.verbose;
  }
}

/**
 * Global logger instance
 */
let globalLogger: Logger | null = null;

/**
 * Create a new logger instance
 */
export function createLogger(options: Partial<LoggerOptions> = {}): Logger {
  return new Logger(options);
}

/**
 * Get the global logger instance (singleton)
 */
export function getLogger(): Logger {
  if (!globalLogger) {
    globalLogger = createLogger({ verbose: isVerboseFromEnv() });
  }
  return globalLogger;
}

/**
 * Set the global logger instance (for testing)
 */
export function setLogger(logger: Logger): void {
  globalLogger = logger;
}

/**
 * Reset the global logger instance (for testing)
 */
export function resetLogger(): void {
  globalLogger = null;
}

/**
 * Logger singleton for backward compatibility
 */
export const logger = {
  log:   (...args: unknown[]) => getLogger().log(...args),
  info:  (...args: unknown[]) => getLogger().info(...args),
  error: (...args: unknown[]) => getLogger().error(...args),
  warn:  (...args: unknown[]) => getLogger().warn(...args),
  debug: (...args: unknown[]) => getLogger().debug(...args),
};
