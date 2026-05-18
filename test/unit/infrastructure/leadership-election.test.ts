import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { forceSchedulerRestart, stopBrowserManager } from '../../../src/infrastructure/browser-manager.ts';

// ---------------------------------------------------------------------------
// Mock poolifier — required so FixedClusterPool never spawns real workers
// ---------------------------------------------------------------------------
vi.mock('poolifier', () => {
  class MockPool {
    execute = vi.fn(async (task: any) => {
      if (task.type === 'search') return { results: [] };
      if (task.type === 'scrape') return { html: '' };
      if (task.type === 'healthcheck') return { success: true };
      return {};
    });
    destroy = vi.fn(async () => {});
  }
  return {
    FixedThreadPool: MockPool,
    FixedClusterPool: MockPool,
    WorkerChoiceStrategies: { LEAST_USED: 'LEAST_USED', ROUND_ROBIN: 'ROUND_ROBIN' },
  };
});

// ---------------------------------------------------------------------------
// Mock BrowserServer so no real HTTP server is started
// ---------------------------------------------------------------------------
vi.mock('../../../src/infrastructure/browser-server.ts', () => {
  return {
    BrowserServer: class {
      constructor(_opts: any) {}
      start = vi.fn(async () => 19999);
      stop = vi.fn(async () => {});
    },
  };
});

// ---------------------------------------------------------------------------
// StateManager mock — we control what getBrowserServer / isPidAlive return
// ---------------------------------------------------------------------------
const mockGetBrowserServer = vi.fn(async () => null as any);
const mockUpdateState = vi.fn(async (fn: (s: any) => any) => {
  // Default: no existing server, so the caller wins the election
  const state: any = { browserServer: null };
  return fn(state);
});
const mockIsPidAlive = vi.fn(async () => false);
const mockClearBrowserServer = vi.fn(async () => {});
const mockReadState = vi.fn(async () => ({ sessions: {} } as any));

vi.mock('../../../src/infrastructure/state-manager.ts', () => {
  return {
    StateManager: class {
      getBrowserServer = mockGetBrowserServer;
      updateState = mockUpdateState;
      isPidAlive = mockIsPidAlive;
      clearBrowserServer = mockClearBrowserServer;
      readState = mockReadState;
    },
  };
});

// ---------------------------------------------------------------------------
// Helper to import the private getScheduler indirectly via runBrowserTask
// ---------------------------------------------------------------------------
import { runBrowserTask } from '../../../src/infrastructure/browser-manager.ts';

// ---------------------------------------------------------------------------

describe('Leadership election', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as any).__PI_RESEARCH_SCHEDULER__ = null;
    (globalThis as any).__PI_RESEARCH_HEALTH_CHECK_PENDING__ = 'some-cached-value';
  });

  afterEach(async () => {
    await stopBrowserManager();
  });

  // -------------------------------------------------------------------------
  // Scenario 1: Win election — no live server exists, this scheduler claims
  // leadership and registers itself in state.
  // -------------------------------------------------------------------------
  it('wins election when no existing server is in state', async () => {
    // No existing server
    mockGetBrowserServer.mockResolvedValue(null);
    mockUpdateState.mockImplementation(async (fn: (s: any) => any) => {
      const state: any = { browserServer: null };
      return fn(state);
    });

    await runBrowserTask('test-win', 'search');

    const scheduler = (globalThis as any).__PI_RESEARCH_SCHEDULER__;
    expect(scheduler).not.toBeNull();

    // updateState should have been called and the state should have been written
    expect(mockUpdateState).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Scenario 2: Lose election — a live server already exists, the new
  // scheduler shuts down and connects as a BrowserClient.
  // -------------------------------------------------------------------------
  it('loses election and connects as client when a live server exists', async () => {
    const existingServer = { port: 19998, pid: 99999, schedulerId: 'existing-leader' };

    // getBrowserServer returns the live server
    mockGetBrowserServer.mockResolvedValue(existingServer);
    // The existing PID is alive
    mockIsPidAlive.mockResolvedValue(true);
    // readState returns a matching schedulerVersion so no forced restart is needed
    mockReadState.mockResolvedValue({
      sessions: {},
      browserServer: existingServer,
      schedulerVersion: undefined, // no version → skip version-mismatch path
    } as any);
    // updateState sees the existing live server and returns it without writing
    mockUpdateState.mockImplementation(async (fn: (s: any) => any) => {
      const state: any = { browserServer: existingServer };
      return fn(state);
    });

    // The import of runBrowserTask will internally call getScheduler which
    // should detect the live server and return a BrowserClient. Because
    // BrowserClient makes HTTP calls we expect a network error here — that's
    // fine; we only care about the scheduler reference that was cached.
    try {
      await runBrowserTask('test-lose', 'search');
    } catch {
      // Expected — BrowserClient cannot connect to a fake port
    }

    const scheduler = (globalThis as any).__PI_RESEARCH_SCHEDULER__;
    // A BrowserClient was stored (not null, not the BrowserTaskScheduler that
    // would have started a server)
    expect(scheduler).not.toBeNull();
    // BrowserClient does not have a `startServer` method
    expect(typeof (scheduler as any).startServer).toBe('undefined');
  });

  // -------------------------------------------------------------------------
  // Scenario 3: Cascade fix — when a scheduler loses leadership its
  // shutdown() MUST NOT clear state that belongs to a different schedulerId.
  // -------------------------------------------------------------------------
  it('shutdown does not clear state owned by a different schedulerId', async () => {
    // Win the election first — this registers ourScheduler
    mockGetBrowserServer.mockResolvedValue(null);
    mockUpdateState.mockImplementation(async (fn: (s: any) => any) => {
      const state: any = { browserServer: null };
      return fn(state);
    });

    await runBrowserTask('test-cascade', 'search');

    const ourScheduler = (globalThis as any).__PI_RESEARCH_SCHEDULER__;
    expect(ourScheduler).not.toBeNull();

    // Now simulate: state now belongs to a DIFFERENT scheduler (e.g., new leader
    // that won after a restart in the same process)
    const differentSchedulerId = 'different-leader-uuid';
    mockGetBrowserServer.mockResolvedValue({
      port: 19997,
      pid: process.pid,        // same PID
      schedulerId: differentSchedulerId, // but different schedulerId
    });

    // Shutting down ourScheduler should NOT call clearBrowserServer because
    // the schedulerId in state no longer matches ours.
    await ourScheduler.shutdown();

    expect(mockClearBrowserServer).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Scenario 4: forceSchedulerRestart clears health check cache
  // -------------------------------------------------------------------------
  it('forceSchedulerRestart clears __PI_RESEARCH_HEALTH_CHECK_PENDING__', async () => {
    (globalThis as any).__PI_RESEARCH_HEALTH_CHECK_PENDING__ = 'some-pending-promise';

    mockGetBrowserServer.mockResolvedValue(null);

    await forceSchedulerRestart();

    expect((globalThis as any).__PI_RESEARCH_HEALTH_CHECK_PENDING__).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Scenario 5: forceSchedulerRestart clears global scheduler reference
  // -------------------------------------------------------------------------
  it('forceSchedulerRestart clears __PI_RESEARCH_SCHEDULER__', async () => {
    (globalThis as any).__PI_RESEARCH_SCHEDULER__ = { fake: 'scheduler' };

    mockGetBrowserServer.mockResolvedValue(null);

    await forceSchedulerRestart();

    expect((globalThis as any).__PI_RESEARCH_SCHEDULER__).toBeNull();
  });
});
