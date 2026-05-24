/**
 * Structured Logger — Context-aware logging with consistent patterns
 *
 * This module provides:
 * - ILogger interface for dependency injection
 * - Context-aware logger factory with component/module tagging
 * - Correlation ID support for request tracking
 * - Structured context data
 * - Consistent log formats
 *
 * Key improvements over direct logger usage:
 * - Testable: can be mocked via ILogger interface
 * - Consistent: standardized formatting across all modules
 * - Structured: machine-readable context data
 * - Traceable: correlation IDs for request tracking
 */

import type { LogContext } from '../logger.ts';

/**
 * Structured log entry interface
 */
export interface StructuredLogEntry {
  timestamp: string;
  level: string;
  component: string;
  correlationId?: string;
  context?: Record<string, unknown>;
  message: string;
  error?: {
    message: string;
    stack?: string;
    code?: string;
  };
}

/**
 * ILogger interface - standard logging abstraction
 *
 * All modules should use this interface for logging instead of direct logger imports.
 * This enables:
 * - Dependency injection for testing
 * - Consistent logging patterns
 * - Structured context support
 */
export interface ILogger {
  /**
   * Log at INFO level with optional context
   */
  info(message: string, context?: LogContext): void;

  /**
   * Log at ERROR level with optional context
   */
  error(message: string, error?: Error | unknown, context?: LogContext): void;

  /**
   * Log at WARN level with optional context
   */
  warn(message: string, context?: LogContext): void;

  /**
   * Log at DEBUG level with optional context
   */
  debug(message: string, context?: LogContext): void;

  /**
   * Create a child logger with additional context
   */
  withContext(context: LogContext): ILogger;

  /**
   * Get the component name for this logger
   */
  getComponent(): string;

  /**
   * Get the correlation ID for this logger (if any)
   */
  getCorrelationId(): string | undefined;
}

/**
 * Options for creating a structured logger
 */
export interface StructuredLoggerOptions {
  component: string;
  correlationId?: string;
  baseContext?: LogContext;
}

/**
 * Structured logger implementation
 *
 * Wraps the global logger with:
 * - Component tagging
 * - Correlation ID tracking
 * - Structured context formatting
 * - Consistent message formatting
 */
class StructuredLogger implements ILogger {
  private component: string;
  private correlationId?: string;
  private baseContext: LogContext;

  constructor(options: StructuredLoggerOptions) {
    this.component = options.component;
    this.correlationId = options.correlationId;
    this.baseContext = options.baseContext ?? {};
  }

  /**
   * Format a log entry with consistent structure
   */
  private formatMessage(
    _level: string,
    message: string,
    _error?: Error | unknown,
    additionalContext?: LogContext
  ): { message: string; context: LogContext } {
    const context: LogContext = {
      ...this.baseContext,
      ...additionalContext,
    } as LogContext;

    if (this.correlationId) {
      (context as Record<string, unknown>)['correlationId'] = this.correlationId;
    }

    return { message, context };
  }

  /**
   * Log at INFO level
   */
  info(message: string, context?: LogContext): void {
    const { message: formattedMessage, context: formattedContext } = this.formatMessage(
      'INFO',
      message,
      undefined,
      context
    );
    this.writeLog('info', formattedMessage, formattedContext);
  }

  /**
   * Log at ERROR level
   */
  error(message: string, error?: Error | unknown, context?: LogContext): void {
    const { message: formattedMessage, context: formattedContext } = this.formatMessage(
      'ERROR',
      message,
      error,
      context
    );

    // For errors, always log with the error object for proper error tracking
    if (error) {
      this.writeLog('error', formattedMessage, formattedContext, error instanceof Error ? error : undefined);
    } else {
      this.writeLog('error', formattedMessage, formattedContext);
    }
  }

  /**
   * Log at WARN level
   */
  warn(message: string, context?: LogContext): void {
    const { message: formattedMessage, context: formattedContext } = this.formatMessage(
      'WARN',
      message,
      undefined,
      context
    );
    this.writeLog('warn', formattedMessage, formattedContext);
  }

  /**
   * Log at DEBUG level
   */
  debug(message: string, context?: LogContext): void {
    const { message: formattedMessage, context: formattedContext } = this.formatMessage(
      'DEBUG',
      message,
      undefined,
      context
    );
    this.writeLog('debug', formattedMessage, formattedContext);
  }

  /**
   * Internal method to write logs via the global logger
   */
  private writeLog(
    level: 'info' | 'error' | 'warn' | 'debug',
    message: string,
    context: LogContext,
    error?: Error
  ): void {
    // Lazy import to avoid circular dependency
    import('../logger.ts').then(({ getLogger, runWithLogContext }) => {
      const globalLogger = getLogger();

      // Run with the log context to include it in the JSON output
      runWithLogContext(context, () => {
        // Pass error object directly if present for proper error tracking
        if (error) {
          globalLogger[level](message, error, context);
        } else {
          globalLogger[level](message, context);
        }
      });
    }).catch(err => {
      // Fallback to console if logger import fails
      console.error(`[StructuredLogger] Failed to import logger:`, err);
      console[level](`[${this.component}] ${message}`, context, error || '');
    });
  }

  /**
   * Create a child logger with additional context
   */
  withContext(context: LogContext): ILogger {
    return new StructuredLogger({
      component: this.component,
      correlationId: this.correlationId,
      baseContext: { ...this.baseContext, ...context },
    });
  }

  /**
   * Get the component name for this logger
   */
  getComponent(): string {
    return this.component;
  }

  /**
   * Get the correlation ID for this logger
   */
  getCorrelationId(): string | undefined {
    return this.correlationId;
  }
}

/**
 * Generate a correlation ID for request/operation tracking
 */
export function generateCorrelationId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 11);
  return `corr-${timestamp}-${random}`;
}

/**
 * Create a structured logger instance
 *
 * @param component - Component/module name (e.g., "BrowserManager", "Orchestrator")
 * @param options - Optional configuration (correlation ID, base context)
 *
 * @example
 * ```ts
 * const logger = createStructuredLogger('BrowserManager');
 * logger.info('Browser pool initialized', { workerCount: 4 });
 *
 * const loggerWithCorrelation = createStructuredLogger('Orchestrator', {
 *   correlationId: generateCorrelationId()
 * });
 * ```
 */
export function createStructuredLogger(
  component: string,
  options?: Partial<StructuredLoggerOptions>
): ILogger {
  return new StructuredLogger({
    component,
    correlationId: options?.correlationId,
    baseContext: options?.baseContext,
  });
}

/**
 * Create a structured logger with an auto-generated correlation ID
 *
 * @param component - Component/module name
 * @param baseContext - Optional base context
 *
 * @example
 * ```ts
 * const logger = createStructuredLoggerWithCorrelation('ResearchCoordinator', {
 *   sessionId: 'session-123'
 * });
 * ```
 */
export function createStructuredLoggerWithCorrelation(
  component: string,
  baseContext?: LogContext
): ILogger {
  return createStructuredLogger(component, {
    correlationId: generateCorrelationId(),
    baseContext,
  });
}

/**
 * Run an operation with a correlation-scoped logger
 *
 * This function creates a logger with a correlation ID, runs the operation,
 * and ensures cleanup. Useful for request-scoped operations.
 *
 * @param component - Component/module name
 * @param operation - Async operation to run
 * @param baseContext - Optional base context
 *
 * @example
 * ```ts
 * const result = await withCorrelationLogger('BrowserManager', async (logger) => {
 *   logger.info('Starting search');
 *   const results = await performSearch(logger);
 *   logger.info('Search complete', { resultCount: results.length });
 *   return results;
 * });
 * ```
 */
export async function withCorrelationLogger<T>(
  component: string,
  operation: (logger: ILogger) => Promise<T>,
  baseContext?: LogContext
): Promise<T> {
  const logger = createStructuredLoggerWithCorrelation(component, baseContext);
  try {
    return await operation(logger);
  } catch (error) {
    logger.error('Operation failed', error);
    throw error;
  }
}

/**
 * No-op logger implementation for testing
 *
 * Use this in tests when you want to suppress logging output.
 */
export class NoOpLogger implements ILogger {
  constructor(private component: string = 'NoOp') {}

  info(_message: string, _context?: LogContext): void {}
  error(_message: string, _error?: Error | unknown, _context?: LogContext): void {}
  warn(_message: string, _context?: LogContext): void {}
  debug(_message: string, _context?: LogContext): void {}

  withContext(_context: LogContext): ILogger {
    return new NoOpLogger(this.component);
  }

  getComponent(): string {
    return this.component;
  }

  getCorrelationId(): string | undefined {
    return undefined;
  }
}

/**
 * In-memory logger for testing
 *
 * Collects log entries in memory for assertion in tests.
 */
export class InMemoryLogger implements ILogger {
  private logs: Array<{ level: string; message: string; context?: LogContext; error?: Error }> = [];

  constructor(private component: string = 'Test') {}

  info(message: string, context?: LogContext): void {
    this.logs.push({ level: 'info', message, context });
  }

  error(message: string, error?: Error | unknown, context?: LogContext): void {
    this.logs.push({ 
      level: 'error', 
      message, 
      context, 
      error: error instanceof Error ? error : undefined 
    });
  }

  warn(message: string, context?: LogContext): void {
    this.logs.push({ level: 'warn', message, context });
  }

  debug(message: string, context?: LogContext): void {
    this.logs.push({ level: 'debug', message, context });
  }

  withContext(_context: LogContext): ILogger {
    return new InMemoryLogger(this.component);
  }

  getComponent(): string {
    return this.component;
  }

  getCorrelationId(): string | undefined {
    return undefined;
  }

  /**
   * Get all logged entries
   */
  getLogs(): Array<{ level: string; message: string; context?: LogContext; error?: Error }> {
    return [...this.logs];
  }

  /**
   * Clear all logged entries
   */
  clear(): void {
    this.logs = [];
  }

  /**
   * Check if a message was logged
   */
  hasLoggedMessage(message: string): boolean {
    return this.logs.some(log => log.message.includes(message));
  }

  /**
   * Check if a log level was used
   */
  hasLogLevel(level: string): boolean {
    return this.logs.some(log => log.level === level);
  }
}