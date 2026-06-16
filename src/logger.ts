/**
 * Logger — scoped file-based diagnostics
 *
 * Writes timestamped lines to {tmpdir}/pi-research-{researchRunId}.log when a researchRunId is provided.
 * Falls back to {tmpdir}/pi-research.log when no researchRunId.
 * ERROR and WARN levels are always logged.
 * INFO and DEBUG levels are only logged when PI_RESEARCH_DEBUG=true (or config.DEBUG=true).
 *
 * This module never patches process-global console.* methods.
 *
 * Write durability / performance contract (see LogWriter):
 *  - WARN/ERROR are written SYNCHRONOUSLY. They are the primary forensic signal
 *    and must survive an immediate crash, so they are never buffered.
 *  - INFO/DEBUG (only emitted when verbose) are buffered and flushed off the
 *    event loop via fs.promises.appendFile, so high-frequency debug logging
 *    never blocks the event loop or the TUI render path — regardless of whether
 *    the log file lives on a fast (tmpfs/RAM) or slow (disk) filesystem. The
 *    buffer is drained synchronously before every WARN/ERROR write (preserving
 *    order) and on process 'exit', so graceful shutdowns lose nothing. Only a
 *    hard SIGKILL can drop the sub-millisecond tail of buffered INFO/DEBUG,
 *    which is acceptable for non-critical diagnostics.
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import * as path from 'node:path';
import { errorTracker, type ErrorContext } from './utils/error-tracker.ts';
import {
  buildDefaultDebugLogPath,
  isVerboseFromEnv,
  getLogContext,
  safeJsonStringify,
  formatArg,
  redactSecrets,
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
  clear(): void;
  flushSync(): void;
  runCapturingStderr<T>(task: () => Promise<T>): Promise<T>;
}

export interface LoggerOptions {
  verbose: boolean;
  logFilePath?: string;
  researchRunId?: string;
  consoleLog?: boolean;
}

export function getDefaultDebugLogPathTemplate(): string {
  return buildDefaultDebugLogPath('{researchRunId}');
}

/**
 * Per-file log writer, shared across every Logger instance that targets the
 * same path (logging is consolidated to one file, so a single shared buffer is
 * required to preserve global write order).
 *
 * INFO/DEBUG go through enqueue() — buffered, flushed asynchronously off the
 * event loop. WARN/ERROR go through writeSync() — which first drains the buffer
 * (keeping order) and then writes synchronously, so critical lines are durable.
 */
class LogWriter {
  private buffer: string[] = [];
  private bufferBytes = 0;
  private flushScheduled = false;
  private flushing = false;
  // Flush eagerly once buffered output gets large, to bound memory and latency
  // during sustained bursts instead of waiting for the scheduled tick.
  private static readonly MAX_BUFFER_BYTES = 256 * 1024;

  constructor(private readonly filePath: string) {}

  /** Queue a line for asynchronous, non-blocking write (INFO/DEBUG path). */
  enqueue(line: string): void {
    this.buffer.push(line);
    this.bufferBytes += line.length;
    if (this.bufferBytes >= LogWriter.MAX_BUFFER_BYTES) {
      void this.flush();
      return;
    }
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushScheduled || this.flushing) return;
    this.flushScheduled = true;
    // setTimeout(0) runs the flush on the next event-loop turn — off the
    // synchronous caller path — and coalesces a burst of lines into one write.
    setTimeout(() => { void this.flush(); }, 0);
  }

  /** Asynchronously write buffered lines. Never blocks the event loop. */
  private async flush(): Promise<void> {
    this.flushScheduled = false;
    if (this.flushing || this.buffer.length === 0) return;
    this.flushing = true;
    try {
      while (this.buffer.length > 0) {
        const batch = this.buffer.join('');
        this.buffer.length = 0;
        this.bufferBytes = 0;
        try {
          await appendFile(this.filePath, batch);
        } catch {
          // Silently ignore file write errors (matches the synchronous path).
        }
      }
    } finally {
      this.flushing = false;
      // A line enqueued after the loop drained but before this point would
      // otherwise linger with no scheduled flush — reschedule defensively.
      if (this.buffer.length > 0) this.scheduleFlush();
    }
  }

  /**
   * Drain buffered lines, then write `line`, all synchronously and in order.
   * Used for WARN/ERROR so the critical line (and everything queued before it)
   * is on disk before this call returns.
   */
  writeSync(line: string): void {
    this.drainSync();
    try {
      appendFileSync(this.filePath, line);
    } catch {
      // Silently ignore file write errors.
    }
  }

  /** Synchronously flush all buffered lines (graceful exit / tests / pre-sync-write). */
  drainSync(): void {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.join('');
    this.buffer.length = 0;
    this.bufferBytes = 0;
    try {
      appendFileSync(this.filePath, batch);
    } catch {
      // Silently ignore file write errors.
    }
  }
}

// One writer per target path → shared, ordered buffer for consolidated logging.
const logWriters = new Map<string, LogWriter>();

// Drain every writer synchronously on graceful process exit so no buffered
// INFO/DEBUG line is lost. Registered exactly once, on first writer creation.
let exitDrainRegistered = false;
function getLogWriter(filePath: string): LogWriter {
  let writer = logWriters.get(filePath);
  if (!writer) {
    writer = new LogWriter(filePath);
    logWriters.set(filePath, writer);
  }
  if (!exitDrainRegistered) {
    exitDrainRegistered = true;
    process.on('exit', () => {
      for (const w of logWriters.values()) {
        try { w.drainSync(); } catch { /* best-effort on exit */ }
      }
    });
  }
  return writer;
}

/** Synchronously flush all buffered log output (e.g. before reading a log file in tests). */
export function flushAllLogsSync(): void {
  for (const w of logWriters.values()) {
    try { w.drainSync(); } catch { /* best-effort */ }
  }
}

/**
 * Symbol used to identify real Logger instances
 */
const LOGGER_BRAND = Symbol.for('pi-research.Logger');

export class Logger implements ILogger {
  private verbose: boolean;
  private consoleLog: boolean;
  private logFile: string;
  private logDir: string;
  private readonly sessionId: string | undefined;
  readonly [LOGGER_BRAND] = true;

  private readonly rotation: LogRotation;
  private readonly diskSpaceChecker: DiskSpaceChecker;

  constructor(options: Partial<LoggerOptions> = {}) {
    this.verbose = options.verbose ?? isVerboseFromEnv();
    this.consoleLog = options.consoleLog ?? (process.env['PI_RESEARCH_CONSOLE_LOG'] === 'true');
    // Consolidated logging: always use the same file regardless of run ID
    this.logFile = options.logFilePath ?? buildDefaultDebugLogPath();
    this.logDir = path.dirname(this.logFile);
    this.sessionId = options.researchRunId;

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
    // Redact credentials and bound size before the message reaches ANY sink, so
    // neither the log file nor the console persists clear-text secrets or
    // unbounded network/scraped payloads.
    const message = redactSecrets(args.map(formatArg).join(' '));
    const entry = {
      timestamp,
      level,
      ...getLogContext(),
      message,
      ...(firstError
        ? { errorMessage: redactSecrets(firstError.message), errorStack: redactSecrets(firstError.stack ?? '') }
        : {}),
    };
    const line = `${safeJsonStringify(entry)}\n`;

    // Write to file. WARN/ERROR are written synchronously for crash-durability;
    // INFO/DEBUG are buffered and flushed off the event loop so high-frequency
    // logging never blocks the loop or the TUI render path (see LogWriter).
    const writer = getLogWriter(this.logFile);
    if (level === LogLevel.ERROR || level === LogLevel.WARN) {
      writer.writeSync(line);
    } else {
      writer.enqueue(line);
    }

    // Optional console output
    if (this.consoleLog) {
      const color = level === LogLevel.ERROR ? '\x1b[31m' :
                    level === LogLevel.WARN ? '\x1b[33m' :
                    level === LogLevel.DEBUG ? '\x1b[90m' : '\x1b[36m';
      const reset = '\x1b[0m';
      // Reuse the already-redacted message; additionally strip CR/LF so untrusted
      // content cannot forge log lines (log-injection defense). The JSON file sink
      // escapes control chars on its own. CodeQL (js/log-injection) StringReplaceSanitizer
      // requires the replacement to be "" (empty string) — not ' ' — per its QL definition:
      //   replaces(s, "") and s.regexpMatch("\\n")
      const msg = message.replace(/[\r\n]/g, '');
      const rawSid = this.sessionId ?? '';
      const sid = rawSid.replace(/[\r\n]/g, '');
      const prefix = sid ? `[${sid}] ` : '';
      console.log(`${color}${timestamp} ${level} ${prefix}${reset}${msg}`);
    }
  }

  async runCapturingStderr<T>(task: () => Promise<T>): Promise<T> {
    return captureStdio(
      this.logFile,
      () => this.diskSpaceChecker.checkDiskSpace(this.logDir),
      task,
      this.sessionId
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

  clear(): void {
    this.flushSync();
    this.rotation.clearLogs(this.logFile, this.logDir);
  }

  /**
   * Synchronously flush this logger's buffered INFO/DEBUG output to disk.
   * Use before reading the log file directly (tests) or during shutdown.
   */
  flushSync(): void {
    getLogWriter(this.logFile).drainSync();
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
      lg = new Logger({ 
        verbose: isVerboseFromEnv(), 
        researchRunId: sessionId,
        consoleLog: process.env['PI_RESEARCH_CONSOLE_LOG'] === 'true'
      });
      sessionLoggers.set(sessionId, lg);
    }
    return lg;
  }
  // Fall back to creating a global logger if no context-bound logger is available
  if (!_globalLogger) {
    _globalLogger = new Logger({ 
      verbose: isVerboseFromEnv(),
      consoleLog: process.env['PI_RESEARCH_CONSOLE_LOG'] === 'true'
    });
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

export function createLogger(options: Partial<LoggerOptions> = {}): Logger {
  if (options.consoleLog === undefined) {
    options.consoleLog = process.env['PI_RESEARCH_CONSOLE_LOG'] === 'true';
  }
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
  clear: () => getLogger().clear(),
  flushSync: () => getLogger().flushSync(),
  runCapturingStderr: <T>(task: () => Promise<T>) => getLogger().runCapturingStderr(task),
};

export { type LogContext };
export { buildDefaultDebugLogPath, isVerboseFromEnv, createResearchRunId, getLogContext, runWithLogContext } from './utils/log-utils.ts';
