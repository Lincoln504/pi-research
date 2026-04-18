/**
 * Tool Usage Tracker
 *
 * Tracks and enforces limits on researcher tool usage.
 * Prevents excessive calls to prevent rate limiting and control costs.
 * Enforcement is code-based only — when a limit is hit, the tool throws.
 */

import { logger } from '../logger.ts';
import { MAX_GATHERING_CALLS, MAX_SCRAPE_CALLS } from '../constants.ts';

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
   * Record a tool call and enforce limits gracefully
   * Returns true if call is allowed and recorded, false if limit is reached.
   * On block: counter is NOT incremented, tool should return a limit message.
   */
  recordCall(toolName: string): boolean {
    const category = this.getCategory(toolName);
    const limit = this.limits[category as keyof ToolLimits];
    const usage = this.getUsage(category);

    // Check limit — if reached, return false without incrementing
    if (limit !== undefined && usage.callCount >= limit) {
      logger.debug(
        `[tool-usage] category=${category} blocked tool=${toolName} (limit=${limit})`
      );
      return false;
    }

    // Allowed — increment and log
    usage.callCount++;
    logger.debug(
      `[tool-usage] category=${category} calls=${usage.callCount}/${limit ?? 'unlimited'} tool=${toolName}`
    );
    return true;
  }

  /**
   * Get current call count for a tool
   */
  getCallCount(toolName: string): number {
    const category = this.getCategory(toolName);
    return this.getUsage(category).callCount;
  }

  /**
   * Get limit-reached message for a blocked tool
   */
  getLimitMessage(toolName: string): string {
    const category = this.getCategory(toolName);
    const usage = this.getUsage(category);
    const limit = usage.limit;

    if (category === 'scrape') {
      return `SCRAPE PROTOCOL COMPLETE: You have completed all ${limit} scrape calls (handshake + 3 batches). ` +
        `This tool cannot be used again. Proceed immediately to Phase 3: synthesize your findings and submit your report.`;
    }
    return `GATHERING LIMIT REACHED: All ${limit} gathering calls have been used. ` +
      `This tool and all other gathering tools cannot be used again. ` +
      `Proceed to Phase 2: call scrape with your collected URLs now.`;
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
    gathering: MAX_GATHERING_CALLS,
    scrape: MAX_SCRAPE_CALLS,
    read: undefined,
  };
}
