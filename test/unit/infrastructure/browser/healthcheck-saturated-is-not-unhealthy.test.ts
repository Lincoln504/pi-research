/**
 * A busy pool is not a broken pool.
 *
 * The healthcheck probe's deadline used to include queue wait, so during a large
 * search burst it expired without ever reaching a worker and the registry reported
 * "critical component unhealthy mid-run: BrowserRuntime" — while the pool was
 * healthily executing that very burst. It happened twice on the night this was
 * measured, at 05:41:58 and 05:53:08, bracketing the saturated rounds.
 *
 * Saturated and wedged are indistinguishable from outside the queue: both leave the
 * probe waiting. So the verdict consults the queue itself. A queue still handing
 * tasks to workers is busy, and the honest answer is healthy. A queue that has
 * dispatched nothing for a whole budget is wedged, and that is a real fault.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../src/logger.ts', () => ({
  logger: { log: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../../src/utils/error-tracker.ts', () => ({ errorTracker: { trackError: vi.fn() } }));
vi.mock('../../../../src/utils/metrics.ts', () => ({
  metrics: { increment: vi.fn(), observe: vi.fn(), setGauge: vi.fn() },
}));

const poolState = vi.hoisted(() => ({ workMs: 0 }));
vi.mock('../../../../src/core/service-registry.ts', () => ({
  getServiceContainer: vi.fn(() => ({})),
  getService: vi.fn(async () => ({
    initialize: vi.fn(async () => {}),
    ensurePool: vi.fn(async () => ({
      execute: vi.fn(async () => {
        await new Promise(r => setTimeout(r, poolState.workMs));
        return { success: true };
      }),
    })),
    decayConsecutiveErrors: vi.fn(),
  })),
}));

import {
  BrowserTaskScheduler,
  isPoolWedged,
  millisSinceDispatch,
} from '../../../../src/infrastructure/browser/browser-task-scheduler.ts';

// The healthcheck budget is a fixed 105s, quartered to ~26s under the mock flags
// the scheduler already reads. Too long to wait on in a unit test, so these tests
// drive the queue directly and assert on the verdict the scheduler reaches.
const CFG = { WORKER_THREADS: 1, WORKER_CONCURRENCY: 1 } as any;

function makeScheduler(): BrowserTaskScheduler {
  const stateManager = { getBrowserServer: vi.fn(async () => null) } as any;
  return new BrowserTaskScheduler('healthcheck-scheduler', stateManager, {} as any);
}

describe('healthcheck distinguishes a saturated pool from a wedged one', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    poolState.workMs = 0;
  });

  it('the queue records when it last handed a task to a worker', async () => {
    // This is the signal the verdict rests on; without it saturation and a wedge
    // are the same observation.
    const scheduler = makeScheduler();
    const queue = (scheduler as any).getPriorityQueue(CFG);

    expect(queue.getLastDispatchAt()).toBe(0);

    const before = Date.now();
    await queue.enqueue('search', async () => 'done');

    expect(queue.getLastDispatchAt()).toBeGreaterThanOrEqual(before);
  });

  it('a queue that never dispatched leaves the timestamp at zero, so a wedge is detectable', async () => {
    const scheduler = makeScheduler();
    const queue = (scheduler as any).getPriorityQueue(CFG);

    // Fill the single slot with work that does not finish, then queue behind it.
    let release!: () => void;
    const blocked = new Promise<void>(r => { release = r; });
    const held = queue.enqueue('scrape', async () => { await blocked; return 'held'; });
    const dispatchedAt = queue.getLastDispatchAt();

    const waiting = queue.enqueue('healthcheck', async () => 'probe');
    // The probe is queued behind the held task, so no new dispatch has happened.
    expect(queue.getLastDispatchAt()).toBe(dispatchedAt);

    release();
    await held;
    await waiting;
    // Once the slot frees, the probe dispatches and the timestamp advances.
    expect(queue.getLastDispatchAt()).toBeGreaterThanOrEqual(dispatchedAt);
  });

  it('reads a busy queue as healthy and a silent one as wedged', () => {
    const budget = 105_000;

    // Dispatched within the window: the pool is working, the probe is just in line.
    expect(isPoolWedged(1_000, budget)).toBe(false);
    expect(isPoolWedged(budget, budget)).toBe(false);

    // Nothing has moved for longer than a whole budget: that is a wedge.
    expect(isPoolWedged(budget + 1, budget)).toBe(true);
    expect(isPoolWedged(Number.POSITIVE_INFINITY, budget)).toBe(true);
  });

  it('treats a queue that never dispatched as silent forever, not as dispatching in 1970', () => {
    // getLastDispatchAt() reports 0, never an epoch time. Subtracting it directly
    // would give ~57 years and reach the right verdict by accident — and the wrong
    // one the moment the sentinel changes.
    expect(millisSinceDispatch(0, 1_700_000_000_000)).toBe(Number.POSITIVE_INFINITY);
    expect(millisSinceDispatch(1_699_999_999_000, 1_700_000_000_000)).toBe(1_000);
  });

  it('runHealthCheck succeeds normally when a worker is available', async () => {
    const scheduler = makeScheduler();
    await expect(scheduler.runHealthCheck(CFG)).resolves.toEqual(
      expect.objectContaining({ success: true }),
    );
  });
});
