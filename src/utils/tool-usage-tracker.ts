/**
 * Tool Usage Tracker
 *
 * Tracks and enforces limits on researcher tool usage.
 * Prevents excessive calls to prevent rate limiting and control costs.
 * Enforcement is code-based only — when a limit is hit, the tool throws.
 */

import { logger } from '../logger.ts';

export interface ToolLimits {
  // Combined gathering limit (search, security_search, stackexchange, grep)
  gathering?: number;
  // Scrape limit
  scrape?: number;
  // read tool (default pi file read) has no limit
  read?: number;
}

export interface ToolUsage {
  category: string;
  callCount: number;
  limit?: number;
}

export class ToolUsageTracker {
  private usage: Map<string, ToolUsage> = new Map();
  private limits: ToolLimits;

  constructor(limits: ToolLimits) {
    this.limits = limits;
  }

  /**
   * Get category for a tool
   */
  private getCategory(toolName: string): string {
    const gatheringTools = ['search', 'security_search', 'stackexchange', 'grep'];
    if (gatheringTools.includes(toolName)) {
      return 'gathering';
    }
    return toolName;
  }

  /**
   * Record a tool call and enforce limits
   * Checks limit BEFORE incrementing to maintain accurate counter state.
   * If limit is hit, throws immediately without incrementing.
   */
  recordCall(toolName: string): void {
    const category = this.getCategory(toolName);
    const limit = this.limits[category as keyof ToolLimits];
    const usage = this.getUsage(category);

    // Check limit BEFORE incrementing — ensures counter state is accurate if we throw
    if (limit !== undefined && usage.callCount >= limit) {
      const errorMsg = category === 'scrape'
        ? `SCRAPE LIMIT REACHED: You have already used your 1 allowed scrape call. ` +
          `Call scrape is no longer available. Proceed to Phase 3: synthesize and report your findings now.`
        : `GATHERING LIMIT REACHED: All ${limit} gathering calls have been used. ` +
          `No further search, security_search, stackexchange, or grep calls are allowed. ` +
          `Proceed to Phase 2: call scrape with your collected URLs now.`;
      throw new Error(errorMsg);
    }

    // Only increment on success (after passing the limit check)
    usage.callCount++;

    // Log successful call for debugging
    logger.debug(
      `[tool-usage] category=${category} calls=${usage.callCount}/${limit ?? 'unlimited'} tool=${toolName}`
    );
  }

  /**
   * Get current usage for a category
   */
  getUsage(category: string): ToolUsage {
    if (!this.usage.has(category)) {
      this.usage.set(category, {
        category,
        callCount: 0,
        limit: this.limits[category as keyof ToolLimits],
      });
    }
    return this.usage.get(category)!;
  }

  /**
   * Get usage statistics for all categories
   */
  getStats(): Map<string, ToolUsage> {
    return new Map(this.usage);
  }

  /**
   * Reset all usage
   */
  reset(): void {
    this.usage.clear();
  }
}

/**
 * Create default tool limits for a researcher
 */
export function createDefaultToolLimits(): ToolLimits {
  return {
    gathering: 6, // 6 rounds of information gathering total
    scrape: 1,    // Only ONE batch scrape allowed
    read: undefined,
  };
}
