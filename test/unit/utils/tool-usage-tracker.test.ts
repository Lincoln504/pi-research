/**
 * Tool Usage Tracker Unit Tests
 *
 * Tests tool usage tracking and limit enforcement.
 */

import { describe, it, expect } from 'vitest';
import { ToolUsageTracker, createDefaultToolLimits } from '../../../src/utils/tool-usage-tracker.ts';

describe('tool-usage-tracker', () => {
  describe('ToolUsageTracker', () => {
    describe('canCall', () => {
      it('should return true for tool with no limit', () => {
        const tracker = new ToolUsageTracker({ gathering: 5 });
        expect(tracker.canCall('scrape')).toBe(true);
      });

      it('should return true for tool under limit (gathering)', () => {
        const tracker = new ToolUsageTracker({ gathering: 5 });
        expect(tracker.canCall('search')).toBe(true);
      });

      it('should return false when gathering limit is reached', () => {
        const tracker = new ToolUsageTracker({ gathering: 2 });
        tracker.recordCall('search');
        tracker.recordCall('grep');
        expect(tracker.canCall('search')).toBe(false);
        expect(tracker.canCall('stackexchange')).toBe(false);
      });

      it('should return false when gathering limit is exceeded', () => {
        const tracker = new ToolUsageTracker({ gathering: 1 });
        tracker.recordCall('search');
        expect(tracker.canCall('security_search')).toBe(false);
      });

      it('should handle unlimited tools', () => {
        const tracker = new ToolUsageTracker({ gathering: 5 });
        for (let i = 0; i < 100; i++) {
          expect(tracker.canCall('read')).toBe(true);
        }
      });

      it('should track gathering vs scrape limits', () => {
        const tracker = new ToolUsageTracker({ gathering: 2, scrape: 1 });
        tracker.recordCall('search');
        tracker.recordCall('grep');
        tracker.recordCall('scrape');

        expect(tracker.canCall('search')).toBe(false);
        expect(tracker.canCall('scrape')).toBe(false);
      });

      it('should handle tool not yet called', () => {
        const tracker = new ToolUsageTracker({ gathering: 5 });
        expect(tracker.canCall('search')).toBe(true);
      });

      it('should return false for zero limit', () => {
        const tracker = new ToolUsageTracker({ gathering: 0 });
        expect(tracker.canCall('search')).toBe(false);
      });
    });

    describe('recordCall', () => {
      it('should record first call', () => {
        const tracker = new ToolUsageTracker({ gathering: 5 });
        tracker.recordCall('search');

        expect(tracker.getUsage('gathering').callCount).toBe(1);
      });

      it('should record multiple calls in same category', () => {
        const tracker = new ToolUsageTracker({ gathering: 5 });
        tracker.recordCall('search');
        tracker.recordCall('grep');
        tracker.recordCall('stackexchange');

        expect(tracker.getUsage('gathering').callCount).toBe(3);
      });

      it('should throw when limit exceeded', () => {
        const tracker = new ToolUsageTracker({ gathering: 2 });
        tracker.recordCall('search');
        tracker.recordCall('grep');

        expect(() => tracker.recordCall('stackexchange')).toThrow('Tool usage limit for gathering exceeded');
      });

      it('should allow calls up to limit', () => {
        const tracker = new ToolUsageTracker({ gathering: 3 });
        tracker.recordCall('search');
        tracker.recordCall('grep');
        tracker.recordCall('stackexchange');

        expect(tracker.getUsage('gathering').callCount).toBe(3);
      });

      it('should not throw for unlimited tools', () => {
        const tracker = new ToolUsageTracker({ gathering: 5 });
        expect(() => {
          for (let i = 0; i < 100; i++) {
            tracker.recordCall('read');
          }
        }).not.toThrow();

        expect(tracker.getUsage('read').callCount).toBe(100);
      });
    });

    describe('getUsage', () => {
      it('should create usage entry if not exists', () => {
        const tracker = new ToolUsageTracker({ gathering: 5 });
        const usage = tracker.getUsage('gathering');

        expect(usage.category).toBe('gathering');
        expect(usage.callCount).toBe(0);
        expect(usage.limit).toBe(5);
      });

      it('should return existing usage entry', () => {
        const tracker = new ToolUsageTracker({ gathering: 5 });
        tracker.recordCall('search');
        tracker.recordCall('grep');

        const usage = tracker.getUsage('gathering');
        expect(usage.callCount).toBe(2);
      });

      it('should handle unlimited tool', () => {
        const tracker = new ToolUsageTracker({ gathering: 5 });
        const usage = tracker.getUsage('read');

        expect(usage.limit).toBeUndefined();
      });
    });

    describe('getStats', () => {
      it('should return empty map initially', () => {
        const tracker = new ToolUsageTracker({ gathering: 5 });
        const stats = tracker.getStats();

        expect(stats.size).toBe(0);
      });

      it('should return stats for used categories', () => {
        const tracker = new ToolUsageTracker({ gathering: 5, scrape: 3 });
        tracker.recordCall('search');
        tracker.recordCall('grep');
        tracker.recordCall('scrape');

        const stats = tracker.getStats();

        expect(stats.size).toBe(2);
        expect(stats.get('gathering')?.callCount).toBe(2);
        expect(stats.get('scrape')?.callCount).toBe(1);
      });
    });

    describe('reset', () => {
      it('should clear all usage', () => {
        const tracker = new ToolUsageTracker({ gathering: 5, scrape: 3 });
        tracker.recordCall('search');
        tracker.recordCall('scrape');

        expect(tracker.getStats().size).toBe(2);

        tracker.reset();

        expect(tracker.getStats().size).toBe(0);
      });

      it('should allow calls after reset', () => {
        const tracker = new ToolUsageTracker({ gathering: 2 });
        tracker.recordCall('search');
        tracker.recordCall('grep');

        expect(tracker.canCall('search')).toBe(false);

        tracker.reset();

        expect(tracker.canCall('search')).toBe(true);
      });
    });
  });

  describe('createDefaultToolLimits', () => {
    it('should return default limits (6 gathering, 1 scrape)', () => {
      const limits = createDefaultToolLimits();

      expect(limits.gathering).toBe(6);
      expect(limits.scrape).toBe(1);
      expect(limits.read).toBeUndefined();
    });

    it('should have limits for gathering and scrape', () => {
      const limits = createDefaultToolLimits();

      expect(limits.gathering).toBeDefined();
      expect(limits.scrape).toBeDefined();
    });
  });
});
