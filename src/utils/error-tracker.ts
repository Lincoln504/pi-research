/**
 * Error Tracker - Session-Scoped Error Pattern Tracking
 *
 * Provides automatic error pattern detection and grouping for research operations.
 * Session-scoped (in-memory) storage that's cleared between research runs.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Error context information for tracking where errors occur
 */
export interface ErrorContext {
  researchId?: string;
  mode?: string;
  component?: string;
  operation?: string;
  toolName?: string;
  phase?: string;
  sessionId?: string;
  url?: string;
  domain?: string;
  [key: string]: unknown;
}

/**
 * Error pattern with aggregated information
 */
export interface ErrorPattern {
  signature: string;
  message: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  contexts: ErrorContext[];
  domainCounts: Map<string, number>;
}

/**
 * Complete error report with aggregated statistics
 */
export interface ErrorReport {
  totalErrors: number;
  uniquePatterns: number;
  patterns: ErrorPattern[];
  byDomain: Map<string, number>;
  byType: Map<string, number>;
}

// Storage for isolation between concurrent research runs
const trackerStorage = new AsyncLocalStorage<ErrorTracker>();

/**
 * Run a function with a specific ErrorTracker bound to the async context.
 */
export function runWithTracker<T>(tracker: ErrorTracker, fn: () => T): T {
  return trackerStorage.run(tracker, fn);
}

/**
 * Session-scoped error tracker with pattern detection
 */
export class ErrorTracker {
  private patterns = new Map<string, ErrorPattern>();
  private readonly MAX_CONTEXTS_PER_PATTERN = 10;
  // Bound total memory. The global singleton is never clear()'d, so out-of-run errors (logger,
  // scrapers, healthcheck) would otherwise grow these maps without limit over a long-lived host.
  private readonly MAX_PATTERNS = 500;
  private readonly MAX_DOMAINS_PER_PATTERN = 100;

  /**
   * Normalize an error message to extract a stable signature.
   * Removes UUIDs, numbers (except HTTP status codes), URLs, and normalizes whitespace.
   *
   * @param message - The error message to normalize
   * @returns A normalized signature for grouping similar errors
   */
  public extractSignature(message: string): string {
    return message
      // Remove UUIDs (8-4-4-4-12 hex format)
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>')
      // Remove numbers (except HTTP status codes like 200, 301, 302, 403, 404, 500, 503)
      .replace(/\b(?![12]\d{2}\b|[3-5]\d{2}\b)\d+\b/g, '<NUM>')
      // Remove URLs
      .replace(/https?:\/\/[^\s]+/g, '<URL>')
      // Normalize whitespace to single spaces
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Track an error with optional context.
   * Groups similar errors by normalized signature and maintains a rolling buffer of contexts.
   *
   * @param error - The error to track (Error object, string message, or unknown)
   * @param context - Optional context information about where the error occurred
   */
  public trackError(error: Error | string | unknown, context: ErrorContext = {}): void {
    let message: string;
    
    if (error instanceof Error) {
      message = error.message;
    } else if (typeof error === 'string') {
      message = error;
    } else {
      // Convert unknown error to string
      message = String(error);
    }
    
    const signature = this.extractSignature(message);
    const now = new Date().toISOString();

    let pattern = this.patterns.get(signature);
    if (!pattern) {
      // Evict the least-frequent pattern before adding a new one at the cap, so the map stays
      // bounded while retaining the highest-signal (most frequent) patterns.
      if (this.patterns.size >= this.MAX_PATTERNS) {
        this.evictLeastFrequentPattern();
      }
      pattern = {
        signature,
        message,
        count: 0,
        firstSeen: now,
        lastSeen: now,
        contexts: [],
        domainCounts: new Map<string, number>(),
      };
      this.patterns.set(signature, pattern);
    }

    pattern.count++;
    pattern.lastSeen = now;

    // Track domain count if available. Cap distinct domains per pattern: existing domains keep
    // incrementing, but once at the cap new distinct domains are dropped to bound memory.
    if (context.domain) {
      const existing = pattern.domainCounts.get(context.domain);
      if (existing !== undefined) {
        pattern.domainCounts.set(context.domain, existing + 1);
      } else if (pattern.domainCounts.size < this.MAX_DOMAINS_PER_PATTERN) {
        pattern.domainCounts.set(context.domain, 1);
      }
    }

    // Add context to rolling buffer (keep only last 10)
    pattern.contexts.push(context);
    if (pattern.contexts.length > this.MAX_CONTEXTS_PER_PATTERN) {
      pattern.contexts.shift();
    }

  }

  /**
   * Generate a complete error report with sorted patterns and domain/type breakdowns.
   *
   * @returns An ErrorReport with aggregated error information
   */
  public getReport(): ErrorReport {
    const patterns = Array.from(this.patterns.values());
    let totalErrors = 0;

    for (const pattern of patterns) {
      totalErrors += pattern.count;
    }

    // Sort patterns by frequency (most frequent first)
    patterns.sort((a, b) => b.count - a.count);

    const byDomain = this.getErrorsByDomain();
    const byType = this.getErrorsByType();

    return {
      totalErrors,
      uniquePatterns: patterns.length,
      patterns,
      byDomain,
      byType,
    };
  }

  /**
   * Group errors by domain from context information.
   *
   * @returns A Map of domain names to error counts
   */
  public getErrorsByDomain(): Map<string, number> {
    const totalDomainCounts = new Map<string, number>();

    for (const pattern of this.patterns.values()) {
      for (const [domain, count] of pattern.domainCounts.entries()) {
        totalDomainCounts.set(domain, (totalDomainCounts.get(domain) ?? 0) + count);
      }
    }

    return totalDomainCounts;
  }

  /**
   * Group errors by type (first part of signature before colon or first few words).
   *
   * @returns A Map of error types to error counts
   */
  public getErrorsByType(): Map<string, number> {
    const typeCounts = new Map<string, number>();

    for (const pattern of this.patterns.values()) {
      // Extract type: first part of signature before colon, or first 3 words
      const parts = pattern.signature.split(':');
      let type = parts[0]?.trim() ?? 'Unknown';
      
      if (type === pattern.signature) {
        // No colon found, use first 3 words
        const words = pattern.signature.split(' ');
        const firstWords = words.slice(0, 3).filter(w => w.length > 0);
        type = firstWords.length > 0 ? firstWords.join(' ') : 'Unknown';
      }

      typeCounts.set(type, (typeCounts.get(type) ?? 0) + pattern.count);
    }

    return typeCounts;
  }

  /**
   * Evict the least-frequent pattern to keep the map bounded (see MAX_PATTERNS). O(n) but only
   * runs when a new signature is added while already at the cap.
   */
  private evictLeastFrequentPattern(): void {
    let victimKey: string | undefined;
    let victimCount = Infinity;
    for (const [key, p] of this.patterns) {
      if (p.count < victimCount) {
        victimCount = p.count;
        victimKey = key;
      }
    }
    if (victimKey !== undefined) {
      this.patterns.delete(victimKey);
    }
  }

  /**
   * Clear all tracked errors (called between research runs).
   */
  public clear(): void {
    this.patterns.clear();
  }
}

/**
 * Global singleton instance that proxies to the context-bound instance if available,
 * enabling session-scoped error isolation while falling back to a shared global tracker.
 */
const globalInstance = new ErrorTracker();
export const errorTracker: ErrorTracker = new Proxy(globalInstance, {
  get(target, prop, receiver) {
    const currentTracker = trackerStorage.getStore() ?? target;
    const value = Reflect.get(currentTracker, prop, receiver);
    if (typeof value === 'function') {
      return value.bind(currentTracker);
    }
    return value;
  }
});