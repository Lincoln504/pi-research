/**
 * Tool Usage Tracker Unit Tests
 *
 * Tests tool usage tracking and limit enforcement.
 */

import { describe, it, expect, vi } from 'vitest';

describe('tool-usage-tracker', () => {
  interface ToolLimits {
    search?: number;
    scrape?: number;
    security_search?: number;
    stackexchange?: number;
    grep?: number;
    read?: number;
  }

  interface ToolUsage {
    toolName: string;
    callCount: number;
    limit?: number;
  }

  class ToolUsageTracker {
    private usage: Map<string, ToolUsage> = new Map();
    private limits: ToolLimits;

    constructor(limits: ToolLimits) {
      this.limits = limits;
    }

    canCall(toolName: string): boolean {
      const limit = this.getLimit(toolName);
      if (limit === undefined) {
        return true;
      }

      const usage = this.getUsage(toolName);
      if (usage.callCount >= limit) {
        return false;
      }

      return true;
    }

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
    }

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

    private getLimit(toolName: string): number | undefined {
      return this.limits[toolName as keyof ToolLimits];
    }

    getStats(): Map<string, ToolUsage> {
      return new Map(this.usage);
    }

    reset(): void {
      this.usage.clear();
    }
  }

  const createDefaultToolLimits = (): ToolLimits => {
    return {
      search: 8,
      scrape: 6,
      security_search: undefined,
      stackexchange: undefined,
      grep: undefined,
      read: undefined,
    };
  };

  describe('ToolUsageTracker', () => {
    describe('canCall', () => {
      it('should return true for tool with no limit', () => {
        const tracker = new ToolUsageTracker({ search: 5 });
        expect(tracker.canCall('scrape')).toBe(true);
      });

      it('should return true for tool under limit', () => {
        const tracker = new ToolUsageTracker({ search: 5 });
        expect(tracker.canCall('search')).toBe(true);
      });

      it('should return false when limit is reached', () => {
        const tracker = new ToolUsageTracker({ search: 2 });
        tracker.recordCall('search');
        tracker.recordCall('search');
        expect(tracker.canCall('search')).toBe(false);
      });

      it('should return false when limit is exceeded', () => {
        const tracker = new ToolUsageTracker({ search: 1 });
        tracker.recordCall('search');
        expect(tracker.canCall('search')).toBe(false);
      });

      it('should allow unlimited tools', () => {
        const tracker = new ToolUsageTracker({ search: 5 });
        for (let i = 0; i < 100; i++) {
          expect(tracker.canCall('scrape')).toBe(true);
        }
      });

      it('should track per-tool limits', () => {
        const tracker = new ToolUsageTracker({ search: 2, scrape: 1 });
        tracker.recordCall('search');
        tracker.recordCall('search');
        tracker.recordCall('scrape');

        expect(tracker.canCall('search')).toBe(false);
        expect(tracker.canCall('scrape')).toBe(false);
      });

      it('should handle tool not yet called', () => {
        const tracker = new ToolUsageTracker({ search: 5 });
        expect(tracker.canCall('search')).toBe(true);
      });

      it('should return false for zero limit', () => {
        const tracker = new ToolUsageTracker({ search: 0 });
        expect(tracker.canCall('search')).toBe(false);
      });
    });

    describe('recordCall', () => {
      it('should record first call', () => {
        const tracker = new ToolUsageTracker({ search: 5 });
        tracker.recordCall('search');

        expect(tracker.getUsage('search').callCount).toBe(1);
      });

      it('should record multiple calls', () => {
        const tracker = new ToolUsageTracker({ search: 5 });
        tracker.recordCall('search');
        tracker.recordCall('search');
        tracker.recordCall('search');

        expect(tracker.getUsage('search').callCount).toBe(3);
      });

      it('should throw when limit exceeded', () => {
        const tracker = new ToolUsageTracker({ search: 2 });
        tracker.recordCall('search');
        tracker.recordCall('search');

        expect(() => tracker.recordCall('search')).toThrow('Tool search usage limit exceeded');
      });

      it('should allow calls up to limit', () => {
        const tracker = new ToolUsageTracker({ search: 3 });
        tracker.recordCall('search');
        tracker.recordCall('search');
        tracker.recordCall('search');

        expect(tracker.getUsage('search').callCount).toBe(3);
      });

      it('should not throw for unlimited tools', () => {
        const tracker = new ToolUsageTracker({ search: 5 });
        expect(() => {
          for (let i = 0; i < 100; i++) {
            tracker.recordCall('scrape');
          }
        }).not.toThrow();

        expect(tracker.getUsage('scrape').callCount).toBe(100);
      });

      it('should track per-tool calls', () => {
        const tracker = new ToolUsageTracker({ search: 5, scrape: 3 });
        tracker.recordCall('search');
        tracker.recordCall('search');
        tracker.recordCall('scrape');

        expect(tracker.getUsage('search').callCount).toBe(2);
        expect(tracker.getUsage('scrape').callCount).toBe(1);
      });

      it('should create usage entry on first call', () => {
        const tracker = new ToolUsageTracker({ search: 5 });
        const stats = tracker.getStats();

        expect(stats.has('search')).toBe(false);

        tracker.recordCall('search');

        expect(tracker.getStats().has('search')).toBe(true);
      });
    });

    describe('getUsage', () => {
      it('should create usage entry if not exists', () => {
        const tracker = new ToolUsageTracker({ search: 5 });
        const usage = tracker.getUsage('search');

        expect(usage.toolName).toBe('search');
        expect(usage.callCount).toBe(0);
        expect(usage.limit).toBe(5);
      });

      it('should return existing usage entry', () => {
        const tracker = new ToolUsageTracker({ search: 5 });
        tracker.recordCall('search');
        tracker.recordCall('search');

        const usage = tracker.getUsage('search');
        expect(usage.callCount).toBe(2);
      });

      it('should handle unlimited tool', () => {
        const tracker = new ToolUsageTracker({ search: 5 });
        const usage = tracker.getUsage('scrape');

        expect(usage.limit).toBeUndefined();
      });

      it('should maintain same reference for same tool', () => {
        const tracker = new ToolUsageTracker({ search: 5 });
        const usage1 = tracker.getUsage('search');
        const usage2 = tracker.getUsage('search');

        expect(usage1).toBe(usage2);
      });
    });

    describe('getStats', () => {
      it('should return empty map initially', () => {
        const tracker = new ToolUsageTracker({ search: 5 });
        const stats = tracker.getStats();

        expect(stats.size).toBe(0);
      });

      it('should return stats for used tools', () => {
        const tracker = new ToolUsageTracker({ search: 5, scrape: 3 });
        tracker.recordCall('search');
        tracker.recordCall('search');
        tracker.recordCall('scrape');

        const stats = tracker.getStats();

        expect(stats.size).toBe(2);
        expect(stats.get('search')?.callCount).toBe(2);
        expect(stats.get('scrape')?.callCount).toBe(1);
      });

      it('should return copy of stats', () => {
        const tracker = new ToolUsageTracker({ search: 5 });
        tracker.recordCall('search');

        const stats1 = tracker.getStats();
        const stats2 = tracker.getStats();

        expect(stats1).not.toBe(stats2);
        expect(stats1.get('search')).toEqual(stats2.get('search'));
      });

      it('should not be affected by modifications to returned map', () => {
        const tracker = new ToolUsageTracker({ search: 5 });
        tracker.recordCall('search');

        const stats = tracker.getStats();
        stats.clear();

        expect(tracker.getStats().size).toBe(1);
      });
    });

    describe('reset', () => {
      it('should clear all usage', () => {
        const tracker = new ToolUsageTracker({ search: 5, scrape: 3 });
        tracker.recordCall('search');
        tracker.recordCall('search');
        tracker.recordCall('scrape');

        expect(tracker.getStats().size).toBe(2);

        tracker.reset();

        expect(tracker.getStats().size).toBe(0);
      });

      it('should allow calls after reset', () => {
        const tracker = new ToolUsageTracker({ search: 2 });
        tracker.recordCall('search');
        tracker.recordCall('search');

        expect(tracker.canCall('search')).toBe(false);

        tracker.reset();

        expect(tracker.canCall('search')).toBe(true);
      });

      it('should reset call counts to zero', () => {
        const tracker = new ToolUsageTracker({ search: 5 });
        tracker.recordCall('search');
        tracker.recordCall('search');
        tracker.recordCall('search');

        tracker.reset();
        tracker.recordCall('search');

        expect(tracker.getUsage('search').callCount).toBe(1);
      });

      it('should handle reset when no calls recorded', () => {
        const tracker = new ToolUsageTracker({ search: 5 });

        expect(() => tracker.reset()).not.toThrow();
        expect(tracker.getStats().size).toBe(0);
      });
    });
  });

  describe('createDefaultToolLimits', () => {
    it('should return default limits', () => {
      const limits = createDefaultToolLimits();

      expect(limits.search).toBe(8);
      expect(limits.scrape).toBe(6);
      expect(limits.security_search).toBeUndefined();
      expect(limits.stackexchange).toBeUndefined();
      expect(limits.grep).toBeUndefined();
      expect(limits.read).toBeUndefined();
    });

    it('should have limits for search and scrape', () => {
      const limits = createDefaultToolLimits();

      expect(limits.search).toBeDefined();
      expect(limits.scrape).toBeDefined();
    });

    it('should have no limits for other tools', () => {
      const limits = createDefaultToolLimits();

      expect(limits.security_search).toBeUndefined();
      expect(limits.stackexchange).toBeUndefined();
      expect(limits.grep).toBeUndefined();
      expect(limits.read).toBeUndefined();
    });
  });

  describe('integration scenarios', () => {
    it('should handle typical researcher session', () => {
      const limits = createDefaultToolLimits();
      const tracker = new ToolUsageTracker(limits);

      // Researcher does some searches
      tracker.recordCall('search');
      tracker.recordCall('search');
      tracker.recordCall('search');
      expect(tracker.getUsage('search').callCount).toBe(3);
      expect(tracker.canCall('search')).toBe(true);

      // Then some scrapes
      tracker.recordCall('scrape');
      tracker.recordCall('scrape');
      expect(tracker.getUsage('scrape').callCount).toBe(2);
      expect(tracker.canCall('scrape')).toBe(true);

      // Unlimited tools work fine
      for (let i = 0; i < 10; i++) {
        tracker.recordCall('stackexchange');
      }
      expect(tracker.getUsage('stackexchange').callCount).toBe(10);
      expect(tracker.canCall('stackexchange')).toBe(true);
    });

    it('should enforce limits correctly', () => {
      const tracker = new ToolUsageTracker({ search: 2, scrape: 1 });

      // Search limit
      tracker.recordCall('search');
      tracker.recordCall('search');
      expect(tracker.canCall('search')).toBe(false);
      expect(() => tracker.recordCall('search')).toThrow();

      // Scrape limit
      tracker.recordCall('scrape');
      expect(tracker.canCall('scrape')).toBe(false);
      expect(() => tracker.recordCall('scrape')).toThrow();
    });

    it('should support session restart', () => {
      const limits = createDefaultToolLimits();
      const tracker = new ToolUsageTracker(limits);

      // First session
      tracker.recordCall('search');
      tracker.recordCall('search');
      tracker.recordCall('search');
      expect(tracker.getUsage('search').callCount).toBe(3);

      // Reset for new session
      tracker.reset();

      // New session
      tracker.recordCall('search');
      expect(tracker.getUsage('search').callCount).toBe(1);
    });
  });
});
