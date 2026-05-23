/**
 * Enhanced Error Tracking with Pattern Recognition
 */

import { logger } from '../logger.ts';

export interface ErrorContext {
  researchId?: string;
  mode?: string;
  component?: string;
  operation?: string;
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

export class ErrorTracker {
  private patterns = new Map<string, ErrorPattern>();
  private readonly MAX_CONTEXTS_PER_PATTERN = 10;
  
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
    
    logger.debug(`[ErrorTracker] Tracked error pattern: ${signature} (Count: ${pattern.count})`);
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

export const errorTracker = new ErrorTracker();