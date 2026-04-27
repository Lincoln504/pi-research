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
  // Specific tool limits (overrides category limit if stricter)
  search?: number;
  // read tool (default pi file read) has no limit
  read?: number;
}

export interface ToolUsage {
  category: string;
  callCount: number;
  limit?: number;
  toolCounts: Map<string, number>;
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
    const catLimit = this.limits[category as keyof ToolLimits];
    const toolLimit = this.limits[toolName as keyof ToolLimits];
    
    const usage = this.getUsage(category);

    // Check category limit
    if (catLimit !== undefined && usage.callCount >= catLimit) {
      logger.debug(
        `[tool-usage] category=${category} blocked tool=${toolName} (limit=${catLimit})`
      );
      return false;
    }

    // Check specific tool limit
    const toolCount = usage.toolCounts.get(toolName) || 0;
    if (toolLimit !== undefined && toolCount >= toolLimit) {
        logger.debug(
            `[tool-usage] tool=${toolName} blocked (limit=${toolLimit})`
        );
        return false;
    }

    // Allowed — increment and log
    usage.callCount++;
    usage.toolCounts.set(toolName, toolCount + 1);
    
    logger.debug(
      `[tool-usage] category=${category} calls=${usage.callCount}/${catLimit ?? 'unlimited'} tool=${toolName} count=${toolCount + 1}/${toolLimit ?? 'unlimited'}`
    );
    return true;
  }

  /**
   * Get current call count for a tool's category
   */
  getCallCount(toolName: string): number {
    const category = this.getCategory(toolName);
    return this.getUsage(category).callCount;
  }

  /**
   * Get current call count for a specific tool
   */
  getToolCallCount(toolName: string): number {
    const category = this.getCategory(toolName);
    const usage = this.getUsage(category);
    return usage.toolCounts.get(toolName) || 0;
  }

  /**
   * Get limit-reached message for a blocked tool
   */
  getLimitMessage(toolName: string): string {
    const category = this.getCategory(toolName);
    const usage = this.getUsage(category);
    
    const toolLimit = this.limits[toolName as keyof ToolLimits];
    const catLimit = usage.limit;

    if (toolName === 'search' && toolLimit === 1) {
        return `SEARCH LIMIT REACHED: Only one massive search call is permitted per agent. ` +
            `You have already executed your search. Use the scrape tool for full deep-dives into your results.`;
    }

    if (category === 'scrape') {
      const limit = catLimit ?? MAX_SCRAPE_CALLS;
      return `SCRAPE PROTOCOL COMPLETE: You have completed all ${limit} scrape batches (Batch 1, Batch 2, Batch 3). ` +
        `This tool cannot be used again. Proceed immediately to Phase 3: synthesize your findings and submit your report.`;
    }
    const limit = catLimit ?? MAX_GATHERING_CALLS;
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
        toolCounts: new Map(),
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
    search: 1,
    read: undefined,
  };
}
