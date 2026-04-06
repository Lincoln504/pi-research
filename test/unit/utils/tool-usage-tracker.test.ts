/**
 * Tool Usage Tracker Unit Tests
 *
 * Tests tool usage tracking and limit enforcement.
 */

import { describe, it, expect } from 'vitest';
import { ToolUsageTracker, createDefaultToolLimits } from '../../../src/utils/tool-usage-tracker.ts';

describe('tool-usage-tracker', () => {
  describe('ToolUsageTracker', () => {

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

      it('should throw when limit reached (on 7th call of 6 limit)', () => {
        const tracker = new ToolUsageTracker({ gathering: 6 });
        tracker.recordCall('search');
        tracker.recordCall('grep');
        tracker.recordCall('stackexchange');
        tracker.recordCall('security_search');
        tracker.recordCall('search');
        tracker.recordCall('grep');

        // 7th call should throw, counter should stay at 6
        expect(() => tracker.recordCall('search')).toThrow('GATHERING LIMIT REACHED');
        expect(tracker.getUsage('gathering').callCount).toBe(6);
      });

      it('should maintain accurate counter state on throw', () => {
        const tracker = new ToolUsageTracker({ gathering: 2 });
        tracker.recordCall('search');
        tracker.recordCall('grep');

        // Counter is at 2. Attempting 3rd call should throw without incrementing
        expect(() => tracker.recordCall('stackexchange')).toThrow('GATHERING LIMIT REACHED');
        expect(tracker.getUsage('gathering').callCount).toBe(2);

        // Even after throw, counter should still be 2
        expect(tracker.getUsage('gathering').callCount).toBe(2);
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

      it('should throw with SCRAPE LIMIT REACHED for scrape', () => {
        const tracker = new ToolUsageTracker({ scrape: 1 });
        tracker.recordCall('scrape');

        expect(() => tracker.recordCall('scrape')).toThrow('SCRAPE LIMIT REACHED');
      });

      it('should throw with phase-transition guidance', () => {
        const tracker = new ToolUsageTracker({ gathering: 1 });
        tracker.recordCall('search');

        expect(() => tracker.recordCall('grep')).toThrow(/Proceed to Phase 2/);
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

        // Counter at 2, should throw on 3rd
        expect(() => tracker.recordCall('stackexchange')).toThrow();

        tracker.reset();

        // After reset, calls should work again
        expect(() => tracker.recordCall('search')).not.toThrow();
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
