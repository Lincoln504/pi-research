/**
 * Tool Usage Tracker
 *
 * Tracks and enforces limits on researcher tool usage.
 * Prevents excessive calls to prevent rate limiting and control costs.
 */

import { logger } from '../logger.js';

export interface ToolLimits {
  // Maximum calls per tool (undefined = no limit)
  search?: number; // 6-8 searches max
  scrape?: number; // 5-6 scrapes max
  security_search?: number; // no limit
  stackexchange?: number; // no limit
  grep?: number; // no limit
  // read tool (default pi file read) has no limit
  read?: number; // no limit
}

export interface ToolUsage {
  toolName: string;
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
   * Check if a tool can be called (within limits)
   * @throws Error if limit exceeded
   */
  canCall(toolName: string): boolean {
    const limit = this.getLimit(toolName);
    if (limit === undefined) {
      // No limit
      return true;
    }

    const usage = this.getUsage(toolName);
    if (usage.callCount >= limit) {
      logger.warn(
        `[tool-usage] Tool ${toolName} limit exceeded: ${usage.callCount}/${limit}`
      );
      return false;
    }

    return true;
  }

  /**
   * Record a tool call and check limits
   * @throws Error if limit exceeded
   */
  recordCall(toolName: string): void {
    const limit = this.getLimit(toolName);

    const usage = this.getUsage(toolName);
    usage.callCount++;

    if (limit !== undefined && usage.callCount > limit) {
      throw new Error(
        `Tool ${toolName} usage limit exceeded: ${usage.callCount}/${limit}. ` +
        `Please adjust your research strategy to stay within limits.`
      );
    }

    if (limit !== undefined && usage.callCount === limit) {
      logger.warn(
        `[tool-usage] Tool ${toolName} at limit: ${usage.callCount}/${limit}`
      );
    }
  }

  /**
   * Get current usage for a tool
   */
  getUsage(toolName: string): ToolUsage {
    if (!this.usage.has(toolName)) {
      this.usage.set(toolName, {
        toolName,
        callCount: 0,
        limit: this.getLimit(toolName),
      });
    }
    return this.usage.get(toolName)!;
  }

  /**
   * Get limit for a tool
   */
  private getLimit(toolName: string): number | undefined {
    return this.limits[toolName as keyof ToolLimits];
  }

  /**
   * Get usage statistics for all tools
   */
  getStats(): Map<string, ToolUsage> {
    return new Map(this.usage);
  }

  /**
   * Reset all usage (for new researcher session)
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
    search: 8, // 6-8 searches max
    scrape: 6, // 5-6 scrapes max
    security_search: undefined, // no limit
    stackexchange: undefined, // no limit
    grep: undefined, // no limit
    read: undefined, // no limit on default pi read tool
  };
}
