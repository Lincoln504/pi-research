import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runBrowserTask, stopBrowserManager } from '../../../src/infrastructure/browser-manager.ts';

// Mock FixedThreadPool
vi.mock('poolifier', () => {
  return {
    FixedThreadPool: class {
        execute = vi.fn(async (task) => {
            if (task.type === 'search') return { results: [] };
            if (task.type === 'scrape') return { html: '<html></html>' };
            if (task.type === 'healthcheck') return { success: true };
            return {};
        });
        destroy = vi.fn(async () => {});
    },
    WorkerChoiceStrategies: { LEAST_USED: 'LEAST_USED' },
  };
});

// Mock StateManager as a class
vi.mock('../../../src/infrastructure/state-manager.ts', () => {
  return {
    StateManager: class {
      getBrowserServer = vi.fn(async () => null);
      updateState = vi.fn(async (fn) => {
          const state = { browserServer: null };
          return fn(state);
      });
      isPidAlive = vi.fn(async () => false);
      clearBrowserServer = vi.fn(async () => {});
      readState = vi.fn(async () => ({ sessions: {} }));
    }
  };
});

describe('BrowserManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as any).__PI_RESEARCH_SCHEDULER__ = null;
  });

  afterEach(async () => {
    await stopBrowserManager();
  });

  it('should run a search task', async () => {
    const results = await runBrowserTask('test query', 'search');
    expect(results).toEqual([]);
  });

  it('should run a scrape task', async () => {
    const result = await runBrowserTask('https://example.com', 'scrape');
    expect(result).toEqual({ html: '<html></html>' });
  });

  it('should reuse scheduler', async () => {
    await runBrowserTask('q1', 'search');
    const firstScheduler = (globalThis as any).__PI_RESEARCH_SCHEDULER__;
    
    await runBrowserTask('q2', 'search');
    const secondScheduler = (globalThis as any).__PI_RESEARCH_SCHEDULER__;
    
    expect(firstScheduler).toBe(secondScheduler);
  });
});
