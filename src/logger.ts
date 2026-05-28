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
import * as path from 'node:path';
import { errorTracker, type ErrorContext } from './utils/error-tracker.ts';
import {
  buildDefaultDebugLogPath,
  isVerboseFromEnv,
  getLogContext,
  safeJsonStringify,
  formatArg,
  type LogContext,
} from './utils/log-utils.ts';
import { LogRotation } from './utils/log-rotation.ts';
import { DiskSpaceChecker } from './utils/disk-space-checker.ts';
import { captureStdio } from './utils/stdio-capture.ts';

export enum LogLevel {
  INFO = 'INFO',
  ERROR = 'ERROR',
  WARN = 'WARN',
  DEBUG = 'DEBUG',
}

export interface ILogger {
  log(...args: unknown[]): void;
  info(...args: unknown[]): void;
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  runCapturingStderr<T>(task: () => Promise<T>): Promise<T>;
}

export interface LoggerOptions {
  verbose: boolean;
  logFilePath?: string;
  researchRunId?: string;
}

export function getDefaultDebugLogPathTemplate(): string {
  return buildDefaultDebugLogPath('{researchRunId}');
}

/**
 * Symbol used to identify real Logger instances
 */
const LOGGER_BRAND = Symbol.for('pi-research.Logger');

export class Logger implements ILogger {
  private verbose: boolean;
  private logFile: string;
  private logDir: string;
  readonly [LOGGER_BRAND] = true;

  private readonly rotation: LogRotation;
  private readonly diskSpaceChecker: DiskSpaceChecker;

  constructor(options: Partial<LoggerOptions> = {}) {
    this.verbose = options.verbose ?? isVerboseFromEnv();
    this.logFile = options.logFilePath ?? buildDefaultDebugLogPath(options.researchRunId);
    this.logDir = path.dirname(this.logFile);

    this.rotation = new LogRotation(this);
    this.diskSpaceChecker = new DiskSpaceChecker();

    // Ensure parent directory exists
    try {
      if (!existsSync(this.logDir)) {
        mkdirSync(this.logDir, { recursive: true });
      }
    } catch {
      // Ignore if we can't create dir
    }
  }

  private emit(level: string, ...args: unknown[]): void {
    // Only filter INFO and DEBUG if not verbose
    if (!this.verbose && (level === LogLevel.INFO || level === LogLevel.DEBUG)) {
      return;
    }

    // Check disk space before writing
    if (!this.diskSpaceChecker.checkDiskSpace(this.logDir)) {
      return;
    }

    // Rotate log file if needed (check every 60 seconds or on ERROR/WARN)
    const force = level === 'ERROR' || level === 'WARN';
    this.rotation.checkAndRotate(this.logFile, this.logDir, force);

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

  async runCapturingStderr<T>(task: () => Promise<T>): Promise<T> {
    return captureStdio(
      this.logFile,
      () => this.diskSpaceChecker.checkDiskSpace(this.logDir),
      task
    );
  }

  log(...args: unknown[]): void {
    this.emit(LogLevel.INFO, ...args);
  }

  info(...args: unknown[]): void {
    this.emit(LogLevel.INFO, ...args);
  }

  error(...args: unknown[]): void {
    const errArg = args.find((arg): arg is Error => arg instanceof Error);
    if (errArg) {
      const context: ErrorContext = getLogContext();
      errorTracker.trackError(errArg, context);
    }
    this.emit(LogLevel.ERROR, ...args);
  }

  warn(...args: unknown[]): void {
    this.emit(LogLevel.WARN, ...args);
  }

  debug(...args: unknown[]): void {
    this.emit(LogLevel.DEBUG, ...args);
  }

  getLogFilePath(): string | null {
    return this.logFile;
  }

  isVerbose(): boolean {
    return this.verbose;
  }
}

// AsyncLocalStorage context for concurrent run isolation
const loggerContext = new AsyncLocalStorage<Logger>();

/**
 * Run a function with a specific logger bound to the async context.
 * All calls to getLogger() within fn (and any async work it spawns) will
 * return this logger instance, providing proper isolation for concurrent runs.
 */
export function runWithLogger<T>(loggerInstance: Logger, fn: () => Promise<T>): Promise<T> {
  return loggerContext.run(loggerInstance, fn);
}

// Session-scoped logger storage to support concurrent research runs
// Each session gets its own logger instance to prevent log bleeding
const sessionLoggers = new Map<string, Logger>();
let _globalLogger: Logger | null = null;

export function getLogger(sessionId?: string): Logger {
  // Check async context first (used for concurrent run isolation via runWithLogger)
  const contextLogger = loggerContext.getStore();
  if (contextLogger) return contextLogger;

  // Return session-scoped logger if sessionId is provided
  if (sessionId) {
    let lg = sessionLoggers.get(sessionId);
    if (!lg) {
      lg = new Logger({ verbose: isVerboseFromEnv(), researchRunId: sessionId });
      sessionLoggers.set(sessionId, lg);
    }
    return lg;
  }
  // Fall back to global logger for backward compatibility
  if (!_globalLogger) {
    _globalLogger = new Logger({ verbose: isVerboseFromEnv() });
  }
  return _globalLogger;
}

export function setLogger(loggerInstance: Logger, sessionId?: string): void {
  if (loggerInstance && !(loggerInstance as any)[LOGGER_BRAND]) {
    throw new Error('setLogger must be called with a Logger instance, not the wrapper.');
  }
  if (sessionId) {
    sessionLoggers.set(sessionId, loggerInstance);
  } else {
    _globalLogger = loggerInstance;
  }
}

export function resetLogger(sessionId?: string): void {
  if (sessionId) {
    sessionLoggers.delete(sessionId);
  } else {
    _globalLogger = null;
    sessionLoggers.clear();
  }
}

export function hasSessionLogger(sessionId: string): boolean {
  return sessionLoggers.has(sessionId);
}

export function createLogger(options: Partial<LoggerOptions> = {}): Logger {
  return new Logger(options);
}

/**
 * Global default logger proxy
 */
export const logger: ILogger = {
  log:   (...args: unknown[]) => getLogger().log(...args),
  info:  (...args: unknown[]) => getLogger().info(...args),
  error: (...args: unknown[]) => getLogger().error(...args),
  warn:  (...args: unknown[]) => getLogger().warn(...args),
  debug: (...args: unknown[]) => getLogger().debug(...args),
  runCapturingStderr: <T>(task: () => Promise<T>) => getLogger().runCapturingStderr(task),
};

export { type LogContext };
export { buildDefaultDebugLogPath, isVerboseFromEnv, createResearchRunId, getLogContext, runWithLogContext } from './utils/log-utils.ts';
