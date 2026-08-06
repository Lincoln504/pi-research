/**
 * Unit tests for the TUI research-health helpers.
 *
 * Pins two behaviors:
 *  1. ensureFunctionalHealth must NOT abort a run when the health check reports
 *     degraded-but-successful — a failed NON-critical component (the optional
 *     KnowledgeStore cache with a dead embedding server) used to flip the aggregate
 *     to unhealthy and abort with a misattributed browser-network error.
 *  2. createHealthMonitor surfaces failed CRITICAL checks mid-run (warn-level,
 *     throttled to once per distinct component per run) in addition to the existing
 *     non-critical warn — previously every registered check was critical, so the
 *     monitor burned a real probe every 30s and could never produce output.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { runHealthCheckMock, runAllMock, isCriticalMock } = vi.hoisted(() => ({
  runHealthCheckMock: vi.fn(),
  runAllMock: vi.fn(),
  isCriticalMock: vi.fn(),
}));

// Full mock: importing the real module registers checks against real config at load.
// The busy-pool discrimination logic is unit-tested in test/unit/healthcheck; here it
// only matters that a success:false result takes the non-busy (abort) path.
vi.mock('../../../src/healthcheck/index.ts', () => ({
  runHealthCheck: runHealthCheckMock,
  healthRegistry: { runAll: runAllMock, isCritical: isCriticalMock },
  isBusyPoolHealthFailure: vi.fn(() => false),
}));

vi.mock('../../../src/logger.ts', () => ({
  logger: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Panel-state manipulation is exercised by the research-panel tests; stub it so these
// tests need no real panel state.
vi.mock('../../../src/tui/research-panel.ts', () => ({
  addSlice: vi.fn(),
  activateSlice: vi.fn(),
  removeSlice: vi.fn(),
}));

import { ensureFunctionalHealth, createHealthMonitor } from '../../../src/tui/research-health.ts';
import { logger } from '../../../src/logger.ts';

const ctx = { panelState: {} as any, onUpdate: () => {} };

describe('ensureFunctionalHealth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does NOT abort on a degraded-but-successful check (optional KnowledgeStore down)', async () => {
    // T1: an embedding-server outage on the optional cache yields success:true /
    // status:'degraded' with no error string — research proceeds, and in particular
    // no "browser hit a network error" message may be fabricated from the store's
    // ECONNREFUSED.
    runHealthCheckMock.mockResolvedValue({
      success: true,
      status: 'degraded',
      components: [
        { component: 'BrowserCapability', healthy: true },
        { component: 'BrowserRuntime', healthy: true },
        { component: 'KnowledgeStore', healthy: false, error: 'Embedding server unreachable: connect ECONNREFUSED 127.0.0.1:7070' },
      ],
      error: undefined,
    });

    await expect(ensureFunctionalHealth(ctx)).resolves.toBeUndefined();
  });

  it('still aborts on a genuine critical failure', async () => {
    runHealthCheckMock.mockResolvedValue({
      success: false,
      status: 'unhealthy',
      components: [{ component: 'BrowserCapability', healthy: false, error: 'Camoufox (browser) not found.' }],
      error: 'Camoufox (browser) not found. Run "npx camoufox-js fetch" to install the browser.',
    });

    await expect(ensureFunctionalHealth(ctx)).rejects.toThrow(/Browser engine not installed/);
  });
});

describe('createHealthMonitor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('warns when a CRITICAL check fails mid-run, throttled to once per component per run', async () => {
    isCriticalMock.mockImplementation((c: string) => c !== 'KnowledgeStore');
    runAllMock.mockResolvedValue({
      status: 'unhealthy',
      components: [{ component: 'BrowserRuntime', healthy: false, error: 'worker reported failure' }],
      timestamp: new Date().toISOString(),
    });

    const monitor = createHealthMonitor();
    monitor.start();
    await vi.advanceTimersByTimeAsync(30000);
    await vi.advanceTimersByTimeAsync(30000); // same failure on the next tick: no second warn
    monitor.stop();

    const criticalWarns = vi.mocked(logger.warn).mock.calls.filter(c => String(c[0]).includes('BrowserRuntime'));
    expect(criticalWarns).toHaveLength(1);
    expect(String(criticalWarns[0]?.[0])).toContain('worker reported failure');
  });

  it('a NEW failing critical component after the first still gets its own warn', async () => {
    isCriticalMock.mockReturnValue(true);
    runAllMock
      .mockResolvedValueOnce({
        status: 'unhealthy',
        components: [{ component: 'BrowserRuntime', healthy: false, error: 'boom' }],
        timestamp: new Date().toISOString(),
      })
      .mockResolvedValue({
        status: 'unhealthy',
        components: [
          { component: 'BrowserRuntime', healthy: false, error: 'boom' },
          { component: 'StateManager', healthy: false, error: 'lock lost' },
        ],
        timestamp: new Date().toISOString(),
      });

    const monitor = createHealthMonitor();
    monitor.start();
    await vi.advanceTimersByTimeAsync(30000);
    await vi.advanceTimersByTimeAsync(30000);
    monitor.stop();

    const warns = vi.mocked(logger.warn).mock.calls.map(c => String(c[0]));
    expect(warns.filter(w => w.includes('BrowserRuntime'))).toHaveLength(1);
    expect(warns.filter(w => w.includes('StateManager'))).toHaveLength(1);
  });

  it('keeps the non-critical warn for degraded optional components', async () => {
    isCriticalMock.mockImplementation((c: string) => c !== 'KnowledgeStore');
    runAllMock.mockResolvedValue({
      status: 'degraded',
      components: [{ component: 'KnowledgeStore', healthy: false, error: 'Embedding server unreachable' }],
      timestamp: new Date().toISOString(),
    });

    const monitor = createHealthMonitor();
    monitor.start();
    await vi.advanceTimersByTimeAsync(30000);
    monitor.stop();

    const warns = vi.mocked(logger.warn).mock.calls.map(c => String(c[0]));
    expect(warns.some(w => w.includes('non-critical') && w.includes('KnowledgeStore'))).toBe(true);
  });
});
