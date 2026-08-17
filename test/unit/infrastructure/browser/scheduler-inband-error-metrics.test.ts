/**
 * In-band worker-error metric ordering.
 *
 * Workers report failures IN-BAND ({ error: '...' } inside a resolved result),
 * not only as rejections. All three scheduler paths used to record the success
 * counter + success-latency histogram BEFORE checking result.error, so every
 * worker-reported failure double-counted as success+error — success-rate
 * dashboards read healthy through a full outage, and the healthcheck flicked
 * browser_pool_health to 1 before flipping it to 0 on the very probe that
 * failed. These tests pin the ordering: an in-band error records ONLY the
 * error side.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../src/logger.ts', () => ({
  logger: { log: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../../src/utils/error-tracker.ts', () => ({
  errorTracker: { trackError: vi.fn() },
}));
vi.mock('../../../../src/utils/metrics.ts', () => ({
  metrics: { increment: vi.fn(), observe: vi.fn(), setGauge: vi.fn(), session: { increment: vi.fn(), setGauge: vi.fn(), observe: vi.fn() }, },
}));

// The scheduler resolves its WorkerPoolManager through the service registry;
// hand it a fake manager whose pool returns a scripted result.
const poolState = vi.hoisted(() => ({
  result: {} as Record<string, unknown>,
}));
vi.mock('../../../../src/core/service-registry.ts', () => ({
  getServiceContainer: vi.fn(() => ({})),
  getService: vi.fn(async () => ({
    initialize: vi.fn(async () => {}),
    ensurePool: vi.fn(async () => ({
      execute: vi.fn(async () => poolState.result),
    })),
    decayConsecutiveErrors: vi.fn(),
  })),
}));

import { BrowserTaskScheduler } from '../../../../src/infrastructure/browser/browser-task-scheduler.ts';
import { metrics } from '../../../../src/utils/metrics.ts';

const CFG = {
  SEARCH_TIMEOUT_MS: 5_000,
  SCRAPE_TIMEOUT_MS: 5_000,
  BROWSER_TASK_TIMEOUT_MS: 2_000,
  WORKER_THREADS: 1,
  WORKER_CONCURRENCY: 1,
} as any;

function makeScheduler(): BrowserTaskScheduler {
  const stateManager = { getBrowserServer: vi.fn(async () => null) } as any;
  return new BrowserTaskScheduler('test-scheduler', stateManager, {} as any);
}

/** All increment calls for a counter name, as their label objects. */
function incrementLabels(name: string): Array<Record<string, string> | undefined> {
  return vi.mocked(metrics.increment).mock.calls.filter(([n]) => n === name).map(([, , labels]) => labels);
}

describe('BrowserTaskScheduler — in-band error metric ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('search: an in-band worker error records error only, never success', async () => {
    poolState.result = { error: 'search worker reported failure' };
    const scheduler = makeScheduler();

    await expect(scheduler.runSearch('q', CFG)).rejects.toThrow('search worker reported failure');

    const labels = incrementLabels('browser_search_requests_total');
    expect(labels).toContainEqual({ status: 'error' });
    expect(labels).not.toContainEqual({ status: 'success' });
    expect(vi.mocked(metrics.observe)).not.toHaveBeenCalledWith(
      'browser_search_duration_ms', expect.anything(), { status: 'success' },
    );
  });

  it('search: a clean result still records the success side', async () => {
    poolState.result = { results: [{ title: 't', url: 'https://x' }] };
    const scheduler = makeScheduler();

    await expect(scheduler.runSearch('q', CFG)).resolves.toEqual([{ title: 't', url: 'https://x' }]);

    expect(incrementLabels('browser_search_requests_total')).toEqual([{ status: 'success' }]);
  });

  it('scrape: an in-band worker error records error only, never success', async () => {
    poolState.result = { error: 'scrape worker reported failure' };
    const scheduler = makeScheduler();

    await expect(scheduler.runScrape('https://example.com', CFG)).rejects.toThrow('scrape worker reported failure');

    const labels = incrementLabels('browser_scrape_requests_total');
    expect(labels).toContainEqual({ status: 'error' });
    expect(labels).not.toContainEqual({ status: 'success' });
    expect(vi.mocked(metrics.observe)).not.toHaveBeenCalledWith(
      'browser_scrape_duration_ms', expect.anything(), { status: 'success' },
    );
  });

  it('healthcheck: an in-band error never flicks browser_pool_health to 1', async () => {
    poolState.result = { success: false, error: 'browser cannot reach the network' };
    const scheduler = makeScheduler();

    await expect(scheduler.runHealthCheck(CFG)).rejects.toThrow('browser cannot reach the network');

    // The gauge must go 0 and ONLY 0 — the pre-fix 1-then-0 flicker read as a
    // healthy pool to anything sampling between the two writes.
    expect(vi.mocked(metrics.setGauge)).toHaveBeenCalledWith('browser_pool_health', 0);
    expect(vi.mocked(metrics.setGauge)).not.toHaveBeenCalledWith('browser_pool_health', 1);
    const labels = incrementLabels('browser_healthcheck_requests_total');
    expect(labels).toContainEqual({ status: 'error' });
    expect(labels).not.toContainEqual({ status: 'success' });
  });

  it('healthcheck: a passing probe records success and sets the gauge to 1', async () => {
    poolState.result = { success: true, navMs: 100 };
    const scheduler = makeScheduler();

    await expect(scheduler.runHealthCheck(CFG)).resolves.toEqual({ success: true, navMs: 100 });

    expect(vi.mocked(metrics.setGauge)).toHaveBeenCalledWith('browser_pool_health', 1);
    expect(incrementLabels('browser_healthcheck_requests_total')).toEqual([{ status: 'success' }]);
  });
});
