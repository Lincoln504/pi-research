/**
 * Enhanced Error Tracking with Pattern Recognition
 */

import type {
  IErrorTracker,
  IErrorTrackerLogger,
  ErrorContext,
  ErrorPattern,
} from '../core/interfaces/error-tracking.ts';

// Re-export types for backward compatibility
export type { ErrorContext, ErrorPattern } from '../core/interfaces/error-tracking.ts';

export class ErrorTracker implements IErrorTracker {
  private patterns = new Map<string, ErrorPattern>();
  private readonly MAX_CONTEXTS_PER_PATTERN = 10;
  private logger: IErrorTrackerLogger | null;
  
  /**
   * Create a new ErrorTracker
   * @param logger - Optional logger instance (prevents circular dependency)
   */
  constructor(logger?: IErrorTrackerLogger) {
    this.logger = logger || null;
  }

  /**
   * Set or update the logger (useful for lazy initialization)
   */
  public setLogger(logger: IErrorTrackerLogger | null): void {
    this.logger = logger;
  }

  /**
   * Normalizes an error message to extract a stable signature.
   * Removes IDs, numbers, and UUIDs to group similar errors.
   */
  private extractSignature(message: string): string {
    return message
      // Remove UUIDs
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/ig, '<UUID>')
      // Remove numbers (except those that look like HTTP status codes)
      .replace(/\b(?![1-5]\d{2}\b)\d+\b/g, '<NUM>')
      // Remove URLs
      .replace(/https?:\/\/[^\s]+/g, '<URL>')
      // Normalize whitespace
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Log a debug message (if logger is available)
   */
  private debug(...args: unknown[]): void {
    if (this.logger) {
      this.logger.debug(...args);
    } else {
      // Fallback to console if no logger
      console.debug('[ErrorTracker]', ...args);
    }
  }

  public trackError(error: Error | string, context: ErrorContext = {}): void {
    const message = error instanceof Error ? error.message : String(error);
    const signature = this.extractSignature(message);
    const now = new Date().toISOString();

    let pattern = this.patterns.get(signature);
    if (!pattern) {
      pattern = {
        signature,
        message: message, // Store first message as representative
        count: 0,
        firstSeen: now,
        lastSeen: now,
        contexts: []
      };
      this.patterns.set(signature, pattern);
    }

    pattern.count++;
    pattern.lastSeen = now;

    // Add context to rolling buffer
    pattern.contexts.push(context);
    if (pattern.contexts.length > this.MAX_CONTEXTS_PER_PATTERN) {
      pattern.contexts.shift(); // Keep only recent contexts
    }

    this.debug(`[ErrorTracker] Tracked error pattern: ${signature} (Count: ${pattern.count})`);
  }

  public getReport(): { totalErrors: number, uniquePatterns: number, patterns: ErrorPattern[] } {
    let totalErrors = 0;
    const patterns = Array.from(this.patterns.values());
    
    for (const p of patterns) {
      totalErrors += p.count;
    }

    // Sort by most frequent
    patterns.sort((a, b) => b.count - a.count);

    return {
      totalErrors,
      uniquePatterns: patterns.length,
      patterns
    };
  }

  public clear(): void {
    this.patterns.clear();
  }
}

// Create singleton without logger initially (will be set by logger module)
export const errorTracker = new ErrorTracker();