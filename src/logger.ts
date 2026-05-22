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
import * as fs from 'node:fs';
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

/**
 * Symbol used to identify real Logger instances to prevent infinite recursion
 * when the wrapper object is accidentally set as the global logger.
 */
const LOGGER_BRAND = Symbol.for('pi-research.Logger');

/**
 * Global flag to prevent concurrent or nested output capture, as process.stderr
 * and process.stdout are shared global resources.
 */
let isAnyLoggerCapturingOutput = false;

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
  readonly [LOGGER_BRAND] = true;

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
   * Run a task while capturing its stderr and stdout, redirecting native logs to the log file.
   * This is useful for capturing logs from native libraries like ONNX Runtime and Dawn.
   */
  async runCapturingStderr<T>(task: () => Promise<T>): Promise<T> {
    if (!this.logFile || isAnyLoggerCapturingOutput) {
        return await task();
    }

    isAnyLoggerCapturingOutput = true;

    // Redirect FD 2 at the OS level so native C++ writes (e.g. Dawn's
    // "maxDynamicStorageBuffersPerPipelineLayout artificially reduced" from
    // libonnxruntime.so via fprintf(stderr,...)) are captured instead of leaking
    // to the terminal. JS-level patches below don't intercept these writes because
    // C++ skips Node.js's process.stderr and fs.writeSync entirely.
    //
    // Strategy (Linux + macOS): fstatSync(2) determines whether FD 2 is a tty or
    // regular file (redirect-worthy) vs. a pipe/socket (skip — FD 2 is owned by
    // the caller, e.g. Pi's --mode rpc where stdout→stderr carries JSON-RPC output,
    // or any programmatic/library use where the parent process reads stderr).
    // open('/dev/fd/2') acts as dup(2), saving a reference to the original target.
    // close(2) + open(logFile) lets the OS assign FD 2 (lowest available) to the
    // log file. Restored in finally via open('/dev/fd/<savedFd>').
    // /dev/fd/N is POSIX — Linux (symlink to /proc/self/fd) and macOS (native).
    // Skipped on Windows where POSIX fd semantics don't apply.
    let savedFd2: number = -1;
    let fd2Redirected = false;
    if (process.platform !== 'win32') {
        try {
            const stat = fs.fstatSync(2);
            // Only redirect when FD 2 is a tty or regular file, not a pipe/socket (MCP mode)
            if (!stat.isFIFO() && !stat.isSocket()) {
                savedFd2 = fs.openSync('/dev/fd/2', 'a');
                fs.closeSync(2);
                const newFd = fs.openSync(this.logFile, 'a');
                if (newFd === 2) {
                    fd2Redirected = true;
                } else {
                    // Didn't get FD 2 — some other FD was released first; undo and skip.
                    if (newFd >= 0) fs.closeSync(newFd);
                    try {
                        const r = fs.openSync(`/dev/fd/${savedFd2}`, 'a');
                        if (r !== 2 && r >= 0) fs.closeSync(r);
                    } catch { /* best-effort restore */ }
                    try { fs.closeSync(savedFd2); } catch { /* ignore */ }
                    savedFd2 = -1;
                }
            }
        } catch { /* fstat failed or /dev/fd unavailable */ }
    }

    const originalStderrWrite = process.stderr.write;
    const originalStdoutWrite = process.stdout.write;
    const originalFsWriteSync = fs.writeSync;
    const originalConsole = {
        log: console.log,
        info: console.info,
        warn: console.warn,
        error: console.error,
        debug: console.debug,
    };
    const logFile = this.logFile;

    // Patch console methods — redirect all application/library logs to the log file
    const patchConsole = (level: string) => {
        return (...args: unknown[]) => {
            const timestamp = new Date().toISOString();
            const entry = {
                timestamp,
                level: `CONSOLE_${level.toUpperCase()}`,
                ...getLogContext(),
                message: args.map(formatArg).join(' '),
            };
            try {
                appendFileSync(logFile, `${safeJsonStringify(entry)}\n`);
            } catch { /* ignore */ }
        };
    };

    console.log = patchConsole('log');
    console.info = patchConsole('info');
    console.warn = patchConsole('warn');
    console.error = patchConsole('error');
    console.debug = patchConsole('debug');

    // Patch stderr.write — capture everything (TUI rarely uses stderr)
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
            appendFileSync(logFile, `${safeJsonStringify(entry)}\n`);
        } catch { /* ignore */ }

        if (typeof cb === 'function') cb();
        return true;
    };

    // Patch stdout.write — selectively capture native logs, preserving TUI output
    (process.stdout.write as any) = (chunk: string | Uint8Array, encodingOrCb?: any, callback?: any) => {
        const message = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
        
        // Native log patterns or plain text that we want to divert from TUI
        const isNativeLog = 
            message.includes('Warning:') || 
            message.includes('Error:') || 
            message.includes('Dawn') || 
            message.includes('ONNX') || 
            message.includes('ort') ||
            message.includes('maxDynamicStorageBuffersPerPipelineLayout') ||
            message.includes('maxComputeWorkgroupStorageSize') ||
            message.includes('allocation limit') ||
            message.includes('artificially') ||
            message.includes('reduced from') ||
            message.includes('dynamic offset allocation limit');

        // TUI check: complex escape codes (cursor movement, screen clear, alternative screen)
        // are almost certainly TUI. Simple color codes (30-37, 90-97) are also often TUI.
        const hasAnsi = message.includes('\x1b[');
        const isComplexTui = 
            message.includes('\x1b[H') ||   // Home
            message.includes('\x1b[2J') ||  // Clear screen
            message.includes('\x1b[J') ||   // Clear to end
            message.includes('\x1b[K') ||   // Clear line
            message.includes('\x1b[?25') || // Cursor visibility
            /\x1b\[\d+;\d+H/.test(message) || // Move to (row, col)
            /\x1b\[\d+[ABCD]/.test(message);   // Relative move
        
        // Box-drawing characters are a definitive TUI marker
        const isBoxDrawing = /[─│┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣╦╩╬╴╵╶╷╭╮╯╰╱╲╳]/.test(message);

        // If it's a known native log, divert it regardless of colors/TUI markers
        // (Native logs sometimes use simple colors, but rarely box-drawing)
        if (isNativeLog && !isBoxDrawing) {
            const timestamp = new Date().toISOString();
            const entry = {
                timestamp,
                level: 'STDOUT_NATIVE',
                ...getLogContext(),
                message: message.trim(),
            };
            try {
                appendFileSync(logFile, `${safeJsonStringify(entry)}\n`);
            } catch { /* ignore */ }

            const cb = typeof encodingOrCb === 'function' ? encodingOrCb : callback;
            if (typeof cb === 'function') cb();
            return true;
        }

        // If it's complex TUI or box-drawing, it's "proper tui" — PASS THROUGH (don't log, don't block)
        if (isComplexTui || isBoxDrawing) {
            return originalStdoutWrite.call(process.stdout, chunk, encodingOrCb, callback);
        }

        // If it's plain text (no ANSI) and non-empty, it's likely a leaked log — divert and log
        if (!hasAnsi && message.trim().length > 0) {
            const timestamp = new Date().toISOString();
            const entry = {
                timestamp,
                level: 'STDOUT_PLAIN',
                ...getLogContext(),
                message: message.trim(),
            };
            try {
                appendFileSync(logFile, `${safeJsonStringify(entry)}\n`);
            } catch { /* ignore */ }

            const cb = typeof encodingOrCb === 'function' ? encodingOrCb : callback;
            if (typeof cb === 'function') cb();
            return true;
        }

        // Everything else (colored text without keywords, empty strings, simple ANSI) goes to stdout
        return originalStdoutWrite.call(process.stdout, chunk, encodingOrCb, callback);
    };

    // Patch fs.writeSync for FD 1 and 2 to catch direct writes from native-adjacent layers.
    // We use a try-catch and check property descriptors for safety across Node.js versions.
    try {
        const descriptor = Object.getOwnPropertyDescriptor(fs, 'writeSync');
        if (!descriptor || (descriptor.writable || descriptor.set)) {
            (fs as any).writeSync = (fd: number, chunk: any, ...args: any[]) => {
                if (fd === 1 || fd === 2) {
                    const message = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
                    
                    // Native log patterns
                    const isNativeLog = 
                        message.includes('Warning:') || 
                        message.includes('Error:') || 
                        message.includes('Dawn') || 
                        message.includes('ONNX') || 
                        message.includes('ort') ||
                        message.includes('maxDynamicStorageBuffersPerPipelineLayout') ||
                        message.includes('maxComputeWorkgroupStorageSize') ||
                        message.includes('allocation limit') ||
                        message.includes('artificially') ||
                        message.includes('reduced from') ||
                        message.includes('dynamic offset allocation limit');

                    const hasAnsi = message.includes('\x1b[');
                    const isBoxDrawing = /[─│┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣╦╩╬╴╵╶╷╭╮╯╰╱╲╳]/.test(message);
                    const isComplexTui = hasAnsi && (
                        message.includes('\x1b[H') || message.includes('\x1b[2J') || 
                        /\x1b\[\d+;\d+H/.test(message) || /\x1b\[\d+[ABCD]/.test(message)
                    );

                    // 100% of stderr is diverted
                    // 100% of plain text stdout is diverted
                    // Native keywords on stdout are diverted (unless they have TUI markers)
                    const shouldDivert = fd === 2 || 
                        (isNativeLog && !isBoxDrawing && !isComplexTui) || 
                        (!hasAnsi && !isBoxDrawing && message.trim().length > 0);

                    if (shouldDivert) {
                        const timestamp = new Date().toISOString();
                        const entry = {
                            timestamp,
                            level: fd === 1 ? 'FS_WRITE_SYNC_STDOUT' : 'FS_WRITE_SYNC_STDERR',
                            ...getLogContext(),
                            message: message.trim(),
                        };
                        try {
                            appendFileSync(logFile, `${safeJsonStringify(entry)}\n`);
                        } catch { /* ignore */ }
                        return (typeof chunk === 'string' ? Buffer.from(chunk).length : (chunk as any).length);
                    }
                }
                return (originalFsWriteSync as any).apply(fs, [fd, chunk, ...args]);
            };
        }
    } catch (e) { /* ignore */ }

    try {
        return await task();
    } finally {
        process.stderr.write = originalStderrWrite;
        process.stdout.write = originalStdoutWrite;
        try {
            (fs as any).writeSync = originalFsWriteSync;
        } catch { /* ignore */ }
        console.log = originalConsole.log;
        console.info = originalConsole.info;
        console.warn = originalConsole.warn;
        console.error = originalConsole.error;
        console.debug = originalConsole.debug;
        isAnyLoggerCapturingOutput = false;

        // Restore FD 2 to its original target (terminal or pipe)
        if (fd2Redirected && savedFd2 >= 0) {
            try {
                fs.closeSync(2);
                const r = fs.openSync(`/dev/fd/${savedFd2}`, 'a');
                if (r !== 2 && r >= 0) {
                    // Didn't recover FD 2 — leave restored FD open so at least
                    // something is on FD 2; the process will likely exit soon anyway.
                }
                try { fs.closeSync(savedFd2); } catch { /* ignore */ }
            } catch { /* ignore restore errors */ }
        }
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
export function setLogger(loggerInstance: Logger): void {
  // Prevent setting the wrapper object which causes infinite recursion.
  // We use a Symbol-based brand check for robustness against multiple module instances.
  if (loggerInstance && !(loggerInstance as any)[LOGGER_BRAND]) {
    throw new Error('setLogger must be called with a Logger instance, not the wrapper.');
  }
  globalLogger = loggerInstance;
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
