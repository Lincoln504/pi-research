/**
 * Logger — scoped file-based diagnostics
 *
 * Writes timestamped lines to {tmpdir}/pi-research-{researchRunId}.log when a researchRunId is provided.
 * Falls back to {tmpdir}/pi-research.log when no researchRunId.
 * ERROR and WARN levels are always logged.
 * INFO and DEBUG levels are only logged when --verbose or PI_RESEARCH_VERBOSE=1 is set.
 *
 * This module never patches process-global console.* methods.
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
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
  researchRunId?: string;  // Optional: use to create per-run log files
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

function buildDefaultDebugLogPath(researchRunId?: string): string {
  if (researchRunId) {
    return path.join(os.tmpdir(), `pi-research-${researchRunId}.log`);
  }
  return path.join(os.tmpdir(), 'pi-research.log');
}

export function getDefaultDebugLogPathTemplate(): string {
  return buildDefaultDebugLogPath('{researchRunId}');
}

/**
 * Check if verbose mode is enabled from environment
 */
export function isVerboseFromEnv(): boolean {
  // Support standard flags and environment variables
  return process.argv.includes('--verbose') || 
         process.argv.includes('-v') ||
         process.argv.includes('--debug') ||
         process.env['PI_RESEARCH_VERBOSE'] === '1' ||
         process.env['PI_RESEARCH_DEBUG'] === '1' ||
         process.env['DEBUG'] === '1' ||
         process.env['DEBUG'] === 'pi-research';
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
 * Logger implementation — writes to file, filters based on verbosity
 */
export class Logger implements ILogger {
  private verbose: boolean;
  private logFile: string;
  private isCapturingStderr = false;

  constructor(options: Partial<LoggerOptions> = {}) {
    this.verbose = options.verbose ?? isVerboseFromEnv();
    this.logFile = options.logFilePath ?? buildDefaultDebugLogPath(options.researchRunId);
    
    // Ensure parent directory exists
    try {
      const dir = path.dirname(this.logFile);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    } catch {
      // Ignore if we can't create dir
    }
  }

  /**
   * Emit a log message to file
   * @param level - Log level (INFO, ERROR, WARN, DEBUG)
   * @param args - Arguments to log
   */
  private emit(level: string, ...args: unknown[]): void {
    // Only filter INFO and DEBUG if not verbose
    if (!this.verbose && (level === LogLevel.INFO || level === LogLevel.DEBUG)) {
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

  /**
   * Run a task while capturing its stderr and redirecting it to the log file.
   * This is useful for capturing logs from native libraries like ONNX Runtime.
   */
  async runCapturingStderr<T>(task: () => Promise<T>): Promise<T> {
    if (!this.verbose || !this.logFile) {
        return await task();
    }
    // If already capturing (concurrent re-entry), run task without re-patching
    if (this.isCapturingStderr) {
        return await task();
    }

    this.isCapturingStderr = true;
    const originalWrite = process.stderr.write;
    const logFile = this.logFile;

    // Patch stderr.write — handles write(chunk), write(chunk, cb), write(chunk, encoding, cb)
    (process.stderr.write as any) = (chunk: string | Uint8Array, encodingOrCb?: any, callback?: any) => {
        const cb = typeof encodingOrCb === 'function' ? encodingOrCb : callback;
        const message = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);

        const timestamp = new Date().toISOString();
        const entry = {
            timestamp,
            level: 'STDERR',
            ...getLogContext(),
            message: message.trim(),
        };
        try {
            appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
        } catch { /* log file write failure is non-fatal during stderr capture */ }

        if (typeof cb === 'function') cb();
        return true;
    };

    try {
        return await task();
    } finally {
        process.stderr.write = originalWrite;
        this.isCapturingStderr = false;
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
