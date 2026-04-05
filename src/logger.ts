/**
 * Logger — File-based logging with global console suppression
 *
 * Silent by default. When --verbose or PI_RESEARCH_VERBOSE=1 is set,
 * writes timestamped lines to /tmp/pi-research-debug-{hash}.log where {hash}
 * is a random 4-character alphanumeric suffix (a-z, 0-9) to keep logs separate per run.
 *
 * When NOT verbose: logFile is null, preventing all /tmp writes.
 * suppressConsole() globally patches console.* to either noop or file-write,
 * catching third-party module output too (e.g., SearXNG lifecycle).
 */

import { appendFileSync } from 'node:fs';

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

/**
 * Check if verbose mode is enabled from environment
 */
export function isVerboseFromEnv(): boolean {
  return (
    process.argv.includes('--verbose') ||
    process.env['PI_RESEARCH_VERBOSE'] === '1'
  );
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
      this.logFile = options.logFilePath ?? `/tmp/pi-research-debug-${hash}.log`;
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

    // Format message
    const timestamp = new Date().toISOString();
    const msg = args
      .map((a) => (a instanceof Error
        ? `${a.message}`
        : typeof a === 'object'
          ? JSON.stringify(a, null, 0)
          : String(a)))
      .join(' ');

    const line = `[${timestamp}] [${level}] ${msg}\n`;

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

/**
 * Globally suppress/redirect all console.* calls.
 * When verbose: redirect to file. When silent: replace with noop.
 * Catches third-party module output too (e.g., SearXNG lifecycle).
 * Returns a restore function to undo the patching.
 */
export function suppressConsole(): () => void {
  const saved = {
    log:   console.log,
    info:  (console as any).info,
    error: console.error,
    warn:  console.warn,
    debug: (console as any).debug,
  };

  const logger = getLogger();
  const verbose = logger.isVerbose();
  const logFile = logger.getLogFilePath();

  const noop = () => {};

  const toFile = (level: string) => (...args: unknown[]) => {
    if (!logFile) return;
    const msg = args
      .map((a) => (a instanceof Error
        ? `${a.message}`
        : typeof a === 'object'
          ? JSON.stringify(a, null, 0)
          : String(a)))
      .join(' ');
    const line = `[${new Date().toISOString()}] [${level}] ${msg}\n`;
    try {
      appendFileSync(logFile, line);
    } catch {
      /* ignore */
    }
  };

  if (verbose) {
    console.log          = toFile('INFO')  as typeof console.log;
    (console as any).info  = toFile('INFO');
    console.error        = toFile('ERROR') as typeof console.error;
    console.warn         = toFile('WARN')  as typeof console.warn;
    (console as any).debug = toFile('DEBUG');
  } else {
    console.log          = noop as typeof console.log;
    (console as any).info  = noop;
    console.error        = noop as typeof console.error;
    console.warn         = noop as typeof console.warn;
    (console as any).debug = noop;
  }

  return () => {
    console.log          = saved.log;
    (console as any).info  = saved.info;
    console.error        = saved.error;
    console.warn         = saved.warn;
    (console as any).debug = saved.debug;
  };
}
