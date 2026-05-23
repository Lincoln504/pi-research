/**
 * Error Tracking Interface
 *
 * Defines the contract for error tracking functionality.
 * This interface allows for dependency injection and breaks circular dependencies.
 */

export interface ErrorContext {
  researchId?: string;
  mode?: string;
  component?: string;
  operation?: string;
  toolName?: string;
  phase?: string;
  sessionId?: string;
  [key: string]: any;
}

export interface ErrorPattern {
  signature: string;
  message: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  contexts: ErrorContext[];
}

export interface ErrorReport {
  totalErrors: number;
  uniquePatterns: number;
  patterns: ErrorPattern[];
}

export interface IErrorTracker {
  /**
   * Track an error with optional context
   */
  trackError(error: Error | string, context?: ErrorContext): void;

  /**
   * Get a report of all tracked errors
   */
  getReport(): ErrorReport;

  /**
   * Clear all tracked errors
   */
  clear(): void;
}

/**
 * Simple logger interface for error tracker
 */
export interface IErrorTrackerLogger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}