/**
 * Tool Limiting Robustness Tests
 *
 * Comprehensive tests for tool usage tracking and limit enforcement.
 * Focuses on robustness, determinism, and error handling.
 */

import { describe, it, expect } from 'vitest';
import { ToolUsageTracker, createDefaultToolLimits } from '../../../src/utils/tool-usage-tracker';
import { createSearchTool } from '../../../src/tools/search';
import { createScrapeTool } from '../../../src/tools/scrape';
import { createSecuritySearchTool } from '../../../src/tools/security';
import { createStackexchangeTool } from '../../../src/tools/stackexchange';
import { createGrepTool } from '../../../src/tools/grep';

describe('tool-limiting-robustness', () => {
  describe('ToolUsageTracker - Robustness', () => {
    describe('Deterministic Behavior', () => {
      it('should always block at the exact limit value', () => {
        const tracker = new ToolUsageTracker({ gathering: 3 });

        // First 3 calls should succeed
        expect(tracker.recordCall('search')).toBe(true);
        expect(tracker.recordCall('grep')).toBe(true);
        expect(tracker.recordCall('stackexchange')).toBe(true);

        // 4th call should always fail
        expect(tracker.recordCall('search')).toBe(false);
        expect(tracker.recordCall('grep')).toBe(false);
        expect(tracker.recordCall('stackexchange')).toBe(false);

        // Counter should remain at limit
        expect(tracker.getUsage('gathering').callCount).toBe(3);
      });

      it('should maintain consistent state across multiple checks', () => {
        const tracker = new ToolUsageTracker({ gathering: 2 });

        // Record 2 calls
        tracker.recordCall('search');
        tracker.recordCall('grep');

        // Multiple checks should all return consistent results
        // getCallCount returns the gathering category count, not per-tool count
        for (let i = 0; i < 10; i++) {
          expect(tracker.getCallCount('search')).toBe(2); // Both calls are in gathering category
          expect(tracker.getCallCount('grep')).toBe(2); // Both calls are in gathering category
          expect(tracker.getUsage('gathering').callCount).toBe(2);
        }
      });

      it('should handle rapid successive calls correctly', () => {
        const tracker = new ToolUsageTracker({ gathering: 5 });

        const results = [];
        for (let i = 0; i < 10; i++) {
          results.push(tracker.recordCall('search'));
        }

        expect(results).toEqual([true, true, true, true, true, false, false, false, false, false]);
      });
    });

    describe('Category Grouping', () => {
      it('should correctly group gathering tools', () => {
        const tracker = new ToolUsageTracker({ gathering: 3 });

        expect(tracker.recordCall('search')).toBe(true);
        expect(tracker.recordCall('security_search')).toBe(true);
        expect(tracker.recordCall('stackexchange')).toBe(true);
        expect(tracker.getUsage('gathering').callCount).toBe(3);

        expect(tracker.recordCall('grep')).toBe(false);
        expect(tracker.getUsage('gathering').callCount).toBe(3);
      });

      it('should treat each scrape call independently', () => {
        const tracker = new ToolUsageTracker({ scrape: 3 });

        for (let i = 0; i < 3; i++) {
          expect(tracker.recordCall('scrape')).toBe(true);
        }

        expect(tracker.recordCall('scrape')).toBe(false);
        expect(tracker.getUsage('scrape').callCount).toBe(3);
      });

      it('should not mix gathering and scrape categories', () => {
        const tracker = new ToolUsageTracker({ gathering: 2, scrape: 2 });

        // Use gathering
        tracker.recordCall('search');
        tracker.recordCall('grep');
        expect(tracker.recordCall('search')).toBe(false);

        // Should still be able to use scrape
        expect(tracker.recordCall('scrape')).toBe(true);
        expect(tracker.recordCall('scrape')).toBe(true);
        expect(tracker.recordCall('scrape')).toBe(false);

        expect(tracker.getUsage('gathering').callCount).toBe(2);
        expect(tracker.getUsage('scrape').callCount).toBe(2);
      });

      it('should handle unlimited categories (read)', () => {
        const tracker = new ToolUsageTracker({ gathering: 1, read: undefined });

        tracker.recordCall('search');
        expect(tracker.recordCall('search')).toBe(false);

        // Read should always work
        for (let i = 0; i < 100; i++) {
          expect(tracker.recordCall('read')).toBe(true);
        }

        expect(tracker.getUsage('read').callCount).toBe(100);
        expect(tracker.getUsage('read').limit).toBeUndefined();
      });
    });

    describe('Edge Cases', () => {
      it('should handle limit of 1 correctly', () => {
        const tracker = new ToolUsageTracker({ gathering: 1 });

        expect(tracker.recordCall('search')).toBe(true);
        expect(tracker.recordCall('search')).toBe(false);
        expect(tracker.getUsage('gathering').callCount).toBe(1);
      });

      it('should handle limit of 0 correctly', () => {
        const tracker = new ToolUsageTracker({ gathering: 0 });

        expect(tracker.recordCall('search')).toBe(false);
        expect(tracker.getUsage('gathering').callCount).toBe(0);
      });

      it('should handle very large limits', () => {
        const tracker = new ToolUsageTracker({ gathering: 10000 });

        for (let i = 0; i < 100; i++) {
          expect(tracker.recordCall('search')).toBe(true);
        }

        expect(tracker.getUsage('gathering').callCount).toBe(100);
      });

      it('should handle mixed tool categories', () => {
        const tracker = new ToolUsageTracker({ gathering: 3, scrape: 2 });

        // Use all gathering
        tracker.recordCall('search');
        tracker.recordCall('grep');
        tracker.recordCall('stackexchange');

        // Use all scrape
        tracker.recordCall('scrape');
        tracker.recordCall('scrape');

        // All should be blocked now
        expect(tracker.recordCall('search')).toBe(false);
        expect(tracker.recordCall('grep')).toBe(false);
        expect(tracker.recordCall('stackexchange')).toBe(false);
        expect(tracker.recordCall('security_search')).toBe(false);
        expect(tracker.recordCall('scrape')).toBe(false);
      });

      it('should handle getting usage for non-existent category', () => {
        const tracker = new ToolUsageTracker({ gathering: 5 });

        const usage = tracker.getUsage('nonexistent');
        expect(usage.category).toBe('nonexistent');
        expect(usage.callCount).toBe(0);
        expect(usage.limit).toBeUndefined();
      });
    });

    describe('Error Handling', () => {
      it('should handle invalid tool names gracefully', () => {
        const tracker = new ToolUsageTracker({ gathering: 5 });

        // Invalid tool names get their own category
        expect(tracker.recordCall('invalid_tool')).toBe(true);
        expect(tracker.getUsage('invalid_tool').callCount).toBe(1);
      });

      it('should handle empty tool names', () => {
        const tracker = new ToolUsageTracker({ gathering: 5 });

        expect(tracker.recordCall('')).toBe(true);
        expect(tracker.getUsage('').callCount).toBe(1);
      });

      it('should handle special characters in tool names', () => {
        const tracker = new ToolUsageTracker({ gathering: 5 });

        expect(tracker.recordCall('tool-with-special-chars_123')).toBe(true);
        expect(tracker.getUsage('tool-with-special-chars_123').callCount).toBe(1);
      });
    });

    describe('State Management', () => {
      it('should clear all usage on reset', () => {
        const tracker = new ToolUsageTracker({ gathering: 3, scrape: 2 });

        tracker.recordCall('search');
        tracker.recordCall('grep');
        tracker.recordCall('scrape');

        tracker.reset();

        expect(tracker.getStats().size).toBe(0);

        // Should work again after reset
        expect(tracker.recordCall('search')).toBe(true);
        expect(tracker.recordCall('scrape')).toBe(true);
      });

      it('should maintain independent state per category', () => {
        const tracker = new ToolUsageTracker({ gathering: 2, scrape: 3 });

        tracker.recordCall('search');
        tracker.recordCall('scrape');
        tracker.recordCall('scrape');

        const gatheringStats = tracker.getUsage('gathering');
        const scrapeStats = tracker.getUsage('scrape');

        expect(gatheringStats.callCount).toBe(1);
        expect(scrapeStats.callCount).toBe(2);
      });

      it('should provide correct stats for all categories', () => {
        const tracker = new ToolUsageTracker({ gathering: 5, scrape: 3 });

        tracker.recordCall('search');
        tracker.recordCall('grep');
        tracker.recordCall('scrape');
        tracker.recordCall('read');

        const stats = tracker.getStats();
        expect(stats.size).toBe(3); // gathering, scrape, read
        expect(stats.get('gathering')?.callCount).toBe(2);
        expect(stats.get('scrape')?.callCount).toBe(1);
        expect(stats.get('read')?.callCount).toBe(1);
      });
    });

    describe('Limit Messages', () => {
      it('should provide correct message for gathering tools', () => {
        const tracker = new ToolUsageTracker({ gathering: 4 });
        const msg = tracker.getLimitMessage('search');

        expect(msg).toContain('GATHERING LIMIT REACHED');
        expect(msg).toContain('4');
        expect(msg).toContain('Step 2');
      });

      it('should provide correct message for scrape tools', () => {
        const tracker = new ToolUsageTracker({ scrape: 3 });
        const msg = tracker.getLimitMessage('scrape');

        expect(msg).toContain('SCRAPE PROTOCOL COMPLETE');
        expect(msg).toContain('3');
        expect(msg).toContain('Step 4');
      });

      it('should provide message for unlimited tools (uses gathering category)', () => {
        const tracker = new ToolUsageTracker({ gathering: 5 });
        const msg = tracker.getLimitMessage('read');

        // Unlimited tools fall back to gathering category message
        expect(msg).toContain('GATHERING LIMIT REACHED');
        expect(msg).toContain('gathering calls');
        expect(msg).toContain('Step 2');
      });
    });

    describe('Thread Safety / Concurrent Access Simulation', () => {
      it('should handle multiple rapid calls to same tool', () => {
        const tracker = new ToolUsageTracker({ gathering: 10 });

        const results = Array.from({ length: 20 }, () =>
          tracker.recordCall('search')
        );

        // First 10 should be true, rest false
        const expected = Array.from({ length: 10 }, () => true)
          .concat(Array.from({ length: 10 }, () => false));
        expect(results).toEqual(expected);
      });

      it('should handle interleaved calls from different tools', () => {
        const tracker = new ToolUsageTracker({ gathering: 6 });

        const tools = ['search', 'grep', 'stackexchange', 'security_search', 'grep', 'search'];
        const results = tools.map(t => tracker.recordCall(t));

        expect(results.every(r => r === true)).toBe(true);
        expect(tracker.getUsage('gathering').callCount).toBe(6);
      });
    });
  });

  describe('Tool Integration - Tracker Integration', () => {
    it('should properly track search tool calls', () => {
      const tracker = new ToolUsageTracker({ gathering: 2 });
      const tool = createSearchTool({ ctx: {} as any, tracker });

      // Verify tool has correct metadata
      expect(tool.name).toBe('search');
      expect(tool.promptGuidelines[0]).toContain('10-30 queries');
    });

    it('should properly track scrape tool calls', () => {
      const tracker = new ToolUsageTracker({ scrape: 2 });
      const tool = createScrapeTool({
        ctx: {} as any,
        tracker,
        getGlobalState: () => ({ allScrapedLinks: [] } as any),
        updateGlobalLinks: () => {},
      });

      // Verify tool has correct metadata
      expect(tool.name).toBe('scrape');
      expect(tool.promptGuidelines).toContain(
        'PROTOCOL: Batch 1 (up to 4 URLs) → Batch 2 (up to 4 URLs).'
      );
    });

    it('should properly track grep tool calls', () => {
      const tracker = new ToolUsageTracker({ gathering: 1 });
      const tool = createGrepTool({ tracker });

      // Verify tool has correct metadata
      expect(tool.name).toBe('grep');
      expect(tool.promptGuidelines).toContainEqual(
        expect.stringContaining('4 gathering calls')
      );
    });

    it('should properly track security_search tool calls', () => {
      const tracker = new ToolUsageTracker({ gathering: 1 });
      const tool = createSecuritySearchTool({ 
        ctx: {} as any, 
        tracker, 
      });

      // Verify tool has correct metadata
      expect(tool.name).toBe('security_search');
      expect(tool.promptGuidelines).toContainEqual(
        expect.stringContaining('4 gathering calls')
      );
    });

    it('should properly track stackexchange tool calls', () => {
      const tracker = new ToolUsageTracker({ gathering: 1 });
      const tool = createStackexchangeTool({
        ctx: {} as any,
        tracker,
      });

      // Verify tool has correct metadata
      expect(tool.name).toBe('stackexchange');
      expect(tool.promptGuidelines).toContainEqual(
        expect.stringContaining('4 gathering calls')
      );
    });
  });

  describe('createDefaultToolLimits', () => {
    it('should create limits with correct values', () => {
      const limits = createDefaultToolLimits();

      expect(limits.gathering).toBe(4);
      expect(limits.scrape).toBe(2);
      expect(limits.read).toBeUndefined();
    });

    it('should return a new object each time', () => {
      const limits1 = createDefaultToolLimits();
      const limits2 = createDefaultToolLimits();

      expect(limits1).not.toBe(limits2);
      expect(limits1).toEqual(limits2);
    });
  });

  describe('Real-World Scenarios', () => {
    it('should simulate typical researcher workflow', () => {
      const tracker = new ToolUsageTracker({ gathering: 4, scrape: 3 });

      // Typical workflow: 2 search, 1 stackexchange, 1 grep = 4 gathering calls
      expect(tracker.recordCall('search')).toBe(true);
      expect(tracker.recordCall('search')).toBe(true);
      expect(tracker.recordCall('stackexchange')).toBe(true);
      expect(tracker.recordCall('grep')).toBe(true);

      // All gathering done, move to scrape
      expect(tracker.recordCall('scrape')).toBe(true); // batch 1
      expect(tracker.recordCall('scrape')).toBe(true); // batch 2
      expect(tracker.recordCall('scrape')).toBe(true); // batch 3

      // Everything blocked now
      expect(tracker.recordCall('search')).toBe(false);
      expect(tracker.recordCall('scrape')).toBe(false);
    });

    it('should handle security research workflow', () => {
      const tracker = new ToolUsageTracker({ gathering: 4, scrape: 2 });

      // Security workflow: 3 security_search, 1 grep
      expect(tracker.recordCall('security_search')).toBe(true);
      expect(tracker.recordCall('security_search')).toBe(true);
      expect(tracker.recordCall('security_search')).toBe(true);
      expect(tracker.recordCall('grep')).toBe(true);

      // All gathering used
      expect(tracker.recordCall('security_search')).toBe(false);
      expect(tracker.recordCall('search')).toBe(false);

      // Scrape still available
      expect(tracker.recordCall('scrape')).toBe(true);
      expect(tracker.recordCall('scrape')).toBe(true);
      expect(tracker.recordCall('scrape')).toBe(false);
    });

    it('should handle code-focused research workflow', () => {
      const tracker = new ToolUsageTracker({ gathering: 4, scrape: 2 });

      // Code workflow: 3 grep, 1 search
      expect(tracker.recordCall('grep')).toBe(true);
      expect(tracker.recordCall('grep')).toBe(true);
      expect(tracker.recordCall('grep')).toBe(true);
      expect(tracker.recordCall('search')).toBe(true);

      // Read should always work
      for (let i = 0; i < 10; i++) {
        expect(tracker.recordCall('read')).toBe(true);
      }
    });
  });
});
