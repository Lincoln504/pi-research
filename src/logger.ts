/**
 * Logger
 *
 * Silent by default. When --verbose or PI_RESEARCH_VERBOSE=1 is set,
 * writes timestamped lines to a log file.
 *
 * Refactored to use dependency injection for testability while maintaining
 * backward compatibility with existing code.
 */

import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
/**
 * Logger configuration options
 */
export interface LoggerOptions {
  verbose: boolean;
  logFilePath?: string;
  setupEmergencyHandlers?: boolean; // For testing, default true
}

/**
 * Default logger options
 */
const DEFAULT_OPTIONS: LoggerOptions = {
  verbose: false,
  logFilePath: undefined,
  setupEmergencyHandlers: true,
};

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
 * Generate default log file path with timestamp
 */
export function getDefaultLogFilePath(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  return join('/tmp', `pi-research-${ts}.log`);
}

/**
 * Setup emergency handlers to ensure log file is saved
 * even if process crashes, is killed, or times out.
 */
export function setupEmergencyHandlers(filePath: string): void {
  if (!filePath) return;

  // Handle graceful shutdown signals
  const cleanupAndExit = (signal: string) => {
    process.stderr.write(`\n[pi-research] Received ${signal}, ensuring logs saved to: ${filePath}\n`);
    process.exit(1);
  };

  // Signal handlers for various termination scenarios
  process.on('SIGINT', () => cleanupAndExit('SIGINT'));   // Ctrl+C
  process.on('SIGTERM', () => cleanupAndExit('SIGTERM')); // kill command
  process.on('SIGHUP', () => cleanupAndExit('SIGHUP'));   // Terminal closed

  // Handle uncaught exceptions
  process.on('uncaughtException', (err: Error) => {
    process.stderr.write(`\n[pi-research] UNCAUGHT EXCEPTION: ${err.message}\n`);
    if (err.stack) {
      process.stderr.write(`${err.stack}\n`);
    }
    process.stderr.write(`[pi-research] Logs saved to: ${filePath}\n`);
    process.exit(1);
  });

  // Handle unhandled promise rejections
  process.on('unhandledRejection', (reason: unknown) => {
    process.stderr.write(`\n[pi-research] UNHANDLED PROMISE REJECTION: ${reason}\n`);
    process.stderr.write(`[pi-research] Logs saved to: ${filePath}\n`);
    process.exit(1);
  });
}

/**
 * Logger implementation
 */
export class Logger implements ILogger {
  private logFile: string | null = null;
  private verbose: boolean;

  constructor(options: Partial<LoggerOptions> = {}) {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    this.verbose = opts.verbose;
    if (this.verbose) {
      this.logFile = opts.logFilePath ?? getDefaultLogFilePath();
      try {
        writeFileSync(this.logFile, `# pi-research verbose log — ${new Date().toISOString()}\n`);
        process.stderr.write(`[pi-research] verbose log: ${this.logFile}\n`);
        if (opts.setupEmergencyHandlers !== false) {
          setupEmergencyHandlers(this.logFile);
        }
      } catch { /* ignore write errors */ }
    }
  }

  /**
   * Write a log entry
   */
  private write(level: string, ...args: unknown[]): void {
    if (!this.logFile || !this.verbose) return;

    const msg = args
      .map((a) => (a instanceof Error
        ? `${a.message}`
        : typeof a === 'object'
          ? JSON.stringify(a, null, 0)
          : String(a)))
      .join(' ');
    const line = `[${new Date().toISOString()}] [${level}] ${msg}\n`;

    try {
      // Use appendFileSync for immediate synchronous write to disk
      appendFileSync(this.logFile, line);
    } catch {
      // Ignore write errors - we're doing our best
    }
  }

  log(...args: unknown[]): void {
    this.write(LogLevel.INFO, ...args);
  }

  info(...args: unknown[]): void {
    this.write(LogLevel.INFO, ...args);
  }

  error(...args: unknown[]): void {
    this.write(LogLevel.ERROR, ...args);
  }

  warn(...args: unknown[]): void {
    this.write(LogLevel.WARN, ...args);
  }

  debug(...args: unknown[]): void {
    this.write(LogLevel.DEBUG, ...args);
  }

  /**
   * Get the log file path (if any)
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
 * Global logger instance (for backward compatibility)
 */
let globalLogger: Logger | null = null;

/**
 * Create a new logger instance
 */
export function createLogger(options: Partial<LoggerOptions> = {}): Logger {
  return new Logger(options);
}

/**
 * Get the global logger instance
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
 * Logger singleton (for backward compatibility)
 */
export const logger = {
  log:   (...args: unknown[]) => getLogger().log(...args),
  info:  (...args: unknown[]) => getLogger().info(...args),
  error: (...args: unknown[]) => getLogger().error(...args),
  warn:  (...args: unknown[]) => getLogger().warn(...args),
  debug: (...args: unknown[]) => getLogger().debug(...args),
};

/**
 * Globally redirect all console.* calls to log file (verbose) or /dev/null (default).
 * This silences output from ALL modules — including internal modules, SearXNG manager, etc.
 * Returns a restore function; call it when research ends to undo the override.
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
    if (logFile) {
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
      } catch { /* ignore */ }
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

// Export for backward compatibility
export const isVerbose = isVerboseFromEnv();
