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
      it('should record first call and return true', () => {
        const tracker = new ToolUsageTracker({ gathering: 5 });
        const allowed = tracker.recordCall('search');

        expect(allowed).toBe(true);
        expect(tracker.getUsage('gathering').callCount).toBe(1);
      });

      it('should record multiple calls in same category and return true', () => {
        const tracker = new ToolUsageTracker({ gathering: 5 });
        expect(tracker.recordCall('search')).toBe(true);
        expect(tracker.recordCall('grep')).toBe(true);
        expect(tracker.recordCall('stackexchange')).toBe(true);

        expect(tracker.getUsage('gathering').callCount).toBe(3);
      });

      it('should return false when limit reached (on 7th call of 6 limit)', () => {
        const tracker = new ToolUsageTracker({ gathering: 6 });
        expect(tracker.recordCall('search')).toBe(true);
        expect(tracker.recordCall('grep')).toBe(true);
        expect(tracker.recordCall('stackexchange')).toBe(true);
        expect(tracker.recordCall('security_search')).toBe(true);
        expect(tracker.recordCall('search')).toBe(true);
        expect(tracker.recordCall('grep')).toBe(true);

        // 7th call should return false, counter should stay at 6
        expect(tracker.recordCall('search')).toBe(false);
        expect(tracker.getUsage('gathering').callCount).toBe(6);
      });

      it('should return false when limit reached without incrementing', () => {
        const tracker = new ToolUsageTracker({ gathering: 2 });
        expect(tracker.recordCall('search')).toBe(true);
        expect(tracker.recordCall('grep')).toBe(true);

        // Counter is at 2. Attempting 3rd call should return false without incrementing
        expect(tracker.recordCall('stackexchange')).toBe(false);
        expect(tracker.getUsage('gathering').callCount).toBe(2);

        // Subsequent calls also blocked
        expect(tracker.recordCall('search')).toBe(false);
        expect(tracker.getUsage('gathering').callCount).toBe(2);
      });

      it('should allow calls up to limit and return true', () => {
        const tracker = new ToolUsageTracker({ gathering: 3 });
        expect(tracker.recordCall('search')).toBe(true);
        expect(tracker.recordCall('grep')).toBe(true);
        expect(tracker.recordCall('stackexchange')).toBe(true);

        expect(tracker.getUsage('gathering').callCount).toBe(3);
      });

      it('should always return true for unlimited tools', () => {
        const tracker = new ToolUsageTracker({ gathering: 5 });
        for (let i = 0; i < 100; i++) {
          expect(tracker.recordCall('read')).toBe(true);
        }

        expect(tracker.getUsage('read').callCount).toBe(100);
      });

      it('should return false with SCRAPE LIMIT REACHED for scrape', () => {
        const tracker = new ToolUsageTracker({ scrape: 1 });
        expect(tracker.recordCall('scrape')).toBe(true);

        const allowed = tracker.recordCall('scrape');
        expect(allowed).toBe(false);

        const msg = tracker.getLimitMessage('scrape');
        expect(msg).toContain('SCRAPE LIMIT REACHED');
      });

      it('should provide phase-transition guidance in limit message', () => {
        const tracker = new ToolUsageTracker({ gathering: 1 });
        tracker.recordCall('search');

        // Get blocked and check the message
        const allowed = tracker.recordCall('grep');
        expect(allowed).toBe(false);

        const msg = tracker.getLimitMessage('grep');
        expect(msg).toContain('Proceed to Phase 2');
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
        expect(tracker.recordCall('search')).toBe(true);
        expect(tracker.recordCall('grep')).toBe(true);

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
        expect(tracker.recordCall('search')).toBe(true);
        expect(tracker.recordCall('grep')).toBe(true);
        expect(tracker.recordCall('scrape')).toBe(true);

        const stats = tracker.getStats();

        expect(stats.size).toBe(2);
        expect(stats.get('gathering')?.callCount).toBe(2);
        expect(stats.get('scrape')?.callCount).toBe(1);
      });
    });

    describe('getLimitMessage', () => {
      it('should provide gathering limit message', () => {
        const tracker = new ToolUsageTracker({ gathering: 6 });
        const msg = tracker.getLimitMessage('search');

        expect(msg).toContain('GATHERING LIMIT REACHED');
        expect(msg).toContain('Phase 2');
      });

      it('should provide scrape limit message', () => {
        const tracker = new ToolUsageTracker({ scrape: 1 });
        const msg = tracker.getLimitMessage('scrape');

        expect(msg).toContain('SCRAPE LIMIT REACHED');
        expect(msg).toContain('Phase 3');
      });
    });

    describe('reset', () => {
      it('should clear all usage', () => {
        const tracker = new ToolUsageTracker({ gathering: 5, scrape: 3 });
        expect(tracker.recordCall('search')).toBe(true);
        expect(tracker.recordCall('scrape')).toBe(true);

        expect(tracker.getStats().size).toBe(2);

        tracker.reset();

        expect(tracker.getStats().size).toBe(0);
      });

      it('should allow calls after reset', () => {
        const tracker = new ToolUsageTracker({ gathering: 2 });
        tracker.recordCall('search');
        tracker.recordCall('grep');

        // Counter at 2, should block on 3rd
        expect(tracker.recordCall('stackexchange')).toBe(false);

        tracker.reset();

        // After reset, calls should work again
        expect(tracker.recordCall('search')).toBe(true);
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
