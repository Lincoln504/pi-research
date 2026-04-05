/**
 * Tool Usage Tracker
 *
 * Tracks and enforces limits on researcher tool usage.
 * Prevents excessive calls to prevent rate limiting and control costs.
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
   * Check if a tool can be called (within limits)
   */
  canCall(toolName: string): boolean {
    const category = this.getCategory(toolName);
    const limit = this.limits[category as keyof ToolLimits];
    if (limit === undefined) {
      return true;
    }

    const usage = this.getUsage(category);
    if (usage.callCount >= limit) {
      logger.warn(
        `[tool-usage] category ${category} limit exceeded: ${usage.callCount}/${limit}`
      );
      return false;
    }

    return true;
  }

  /**
   * Record a tool call and check limits
   */
  recordCall(toolName: string): void {
    const category = this.getCategory(toolName);
    const limit = this.limits[category as keyof ToolLimits];

    const usage = this.getUsage(category);
    usage.callCount++;

    if (limit !== undefined && usage.callCount > limit) {
      throw new Error(
        `Tool usage limit for ${category} exceeded: ${usage.callCount}/${limit}. ` +
        `Please adjust your research strategy to stay within limits.`
      );
    }
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
