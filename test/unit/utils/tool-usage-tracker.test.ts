import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ToolUsageTracker, createDefaultToolLimits } from '../../../src/utils/tool-usage-tracker';

vi.mock('../../../src/logger.ts', () => ({
  logger: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../src/constants.ts', () => ({
  MAX_GATHERING_CALLS: 10,
  MAX_GREP_CALLS: 30,
  getMaxGatheringCalls: vi.fn(() => 10),
  getMaxScrapeBatches: vi.fn(() => 2),
}));

describe('ToolUsageTracker', () => {
  describe('createDefaultToolLimits', () => {
    it('returns gathering=10, scrape=2, search=1, grep=30, read=undefined', () => {
      const limits = createDefaultToolLimits();
      expect(limits.gathering).toBe(10);
      expect(limits.scrape).toBe(2);
      expect(limits.search).toBe(1);
      expect(limits.grep).toBe(30);
      expect(limits.read).toBeUndefined();
    });
  });

  describe('category grouping', () => {
    let tracker: ToolUsageTracker;

    beforeEach(() => {
      tracker = new ToolUsageTracker({ gathering: 5 });
    });

    it('search, security_search, stackexchange share the gathering category', () => {
      tracker.recordCall('search');
      tracker.recordCall('security_search');
      tracker.recordCall('stackexchange');
      expect(tracker.getCallCount('search')).toBe(3);
      expect(tracker.getCallCount('security_search')).toBe(3);
    });

    it('grep is its own category, NOT part of gathering (local/free)', () => {
      tracker.recordCall('search');
      tracker.recordCall('grep');
      // gathering only counts the search call; grep is tracked separately
      expect(tracker.getCallCount('search')).toBe(1);
      expect(tracker.getCallCount('grep')).toBe(1);
    });

    it('scrape is its own category separate from gathering', () => {
      tracker.recordCall('search');
      expect(tracker.getCallCount('scrape')).toBe(0);
    });
  });

  describe('recordCall', () => {
    it('allows calls within category limit and increments counter', () => {
      const tracker = new ToolUsageTracker({ gathering: 2 });
      expect(tracker.recordCall('search')).toBe(true);
      expect(tracker.recordCall('security_search')).toBe(true);
      expect(tracker.getCallCount('search')).toBe(2);
    });

    it('blocks and does NOT increment when category limit is reached', () => {
      const tracker = new ToolUsageTracker({ gathering: 1 });
      tracker.recordCall('search');
      const allowed = tracker.recordCall('security_search');
      expect(allowed).toBe(false);
      // category total is 1 (from the search call); blocked security_search was not counted
      expect(tracker.getCallCount('security_search')).toBe(1);
    });

    it('grep has its own budget and is not blocked by the gathering limit', () => {
      const tracker = new ToolUsageTracker({ gathering: 1, grep: 2 });
      tracker.recordCall('search'); // gathering now full
      expect(tracker.recordCall('grep')).toBe(true);
      expect(tracker.recordCall('grep')).toBe(true);
      expect(tracker.recordCall('grep')).toBe(false); // grep's own limit hit
      expect(tracker.getCallCount('grep')).toBe(2);
    });

    it('blocks on tool-specific limit independently of category limit', () => {
      const tracker = new ToolUsageTracker({ gathering: 10, search: 1 });
      expect(tracker.recordCall('search')).toBe(true);
      expect(tracker.recordCall('search')).toBe(false);
      expect(tracker.getToolCallCount('search')).toBe(1);
    });

    it('does not increment when tool-specific limit is blocked', () => {
      const tracker = new ToolUsageTracker({ gathering: 10, search: 1 });
      tracker.recordCall('search');
      tracker.recordCall('search'); // blocked
      expect(tracker.getToolCallCount('search')).toBe(1);
    });

    it('allows scrape calls within scrape limit', () => {
      const tracker = new ToolUsageTracker({ scrape: 2 });
      expect(tracker.recordCall('scrape')).toBe(true);
      expect(tracker.recordCall('scrape')).toBe(true);
      expect(tracker.recordCall('scrape')).toBe(false);
    });

    it('returns true when no limits are set', () => {
      const tracker = new ToolUsageTracker({});
      expect(tracker.recordCall('search')).toBe(true);
      expect(tracker.recordCall('grep')).toBe(true);
    });
  });

  describe('getCallCount and getToolCallCount', () => {
    it('getCallCount returns category total across all tools', () => {
      const tracker = new ToolUsageTracker({ gathering: 10 });
      tracker.recordCall('search');
      tracker.recordCall('security_search');
      tracker.recordCall('stackexchange');
      expect(tracker.getCallCount('search')).toBe(3);
    });

    it('getToolCallCount returns count for that specific tool only', () => {
      const tracker = new ToolUsageTracker({ gathering: 10 });
      tracker.recordCall('search');
      tracker.recordCall('search');
      tracker.recordCall('grep');
      expect(tracker.getToolCallCount('search')).toBe(2);
      expect(tracker.getToolCallCount('grep')).toBe(1);
    });

    it('returns 0 for a tool that has not been called', () => {
      const tracker = new ToolUsageTracker({});
      expect(tracker.getToolCallCount('search')).toBe(0);
      expect(tracker.getCallCount('search')).toBe(0);
    });
  });

  describe('getLimitMessage', () => {
    it('returns SEARCH LIMIT REACHED message for search with limit=1', () => {
      const tracker = new ToolUsageTracker({ search: 1 });
      const msg = tracker.getLimitMessage('search');
      expect(msg).toContain('SEARCH LIMIT REACHED');
      expect(msg).toContain('one search call');
    });

    it('returns SCRAPE PROTOCOL COMPLETE for scrape', () => {
      const tracker = new ToolUsageTracker({ scrape: 2 });
      const msg = tracker.getLimitMessage('scrape');
      expect(msg).toContain('SCRAPE PROTOCOL COMPLETE');
      expect(msg).toContain('2 batches');
    });

    it('SCRAPE message includes batch list', () => {
      const tracker = new ToolUsageTracker({ scrape: 3 });
      const msg = tracker.getLimitMessage('scrape');
      expect(msg).toContain('Batch 1');
      expect(msg).toContain('Batch 2');
      expect(msg).toContain('Batch 3');
    });

    it('returns GATHERING LIMIT REACHED for security_search', () => {
      const tracker = new ToolUsageTracker({ gathering: 10 });
      const msg = tracker.getLimitMessage('security_search');
      expect(msg).toContain('GATHERING LIMIT REACHED');
      expect(msg).toContain('10 gathering calls');
    });

    it('returns CODE SEARCH LIMIT REACHED for grep (its own budget)', () => {
      const tracker = new ToolUsageTracker({ gathering: 5, grep: 30 });
      const msg = tracker.getLimitMessage('grep');
      expect(msg).toContain('CODE SEARCH LIMIT REACHED');
      expect(msg).toContain('30');
    });
  });

  describe('reset', () => {
    it('clears all call counts and re-allows blocked calls', () => {
      const tracker = new ToolUsageTracker({ search: 1, gathering: 1 });
      tracker.recordCall('search');
      expect(tracker.recordCall('search')).toBe(false);
      tracker.reset();
      expect(tracker.getCallCount('search')).toBe(0);
      expect(tracker.getToolCallCount('search')).toBe(0);
      expect(tracker.recordCall('search')).toBe(true);
    });
  });
});
