/**
 * Regression: the leadership self-check must NOT be armed in the constructor.
 * The check compares the persisted browserServer.schedulerId against ours, but a
 * scheduler does not register itself as leader until after construction (the
 * factory's election). Arming it in the constructor let it race its own
 * registration and self-shut-down mid-init under lock contention. It is now
 * armed only via startLeadershipMonitor() (called once the election is won).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/logger.ts', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));
vi.mock('../../../src/utils/metrics.ts', () => ({
  metrics: { increment: vi.fn(), setGauge: vi.fn(), observe: vi.fn() },
}));

import { BrowserTaskScheduler } from '../../../src/infrastructure/browser/browser-task-scheduler.ts';

describe('BrowserTaskScheduler — leadership monitor timing', () => {
  let scheduler: BrowserTaskScheduler;

  beforeEach(() => {
    const stateManager: any = { getBrowserServer: vi.fn(async () => null) };
    scheduler = new BrowserTaskScheduler('sched-1', stateManager, {} as any);
  });

  it('does not arm the leadership timer in the constructor', () => {
    expect((scheduler as any).leadershipTimer).toBeNull();
    expect((scheduler as any).leadershipMonitorStarted).toBe(false);
  });

  it('arms the leadership timer when startLeadershipMonitor() is called', () => {
    scheduler.startLeadershipMonitor();
    expect((scheduler as any).leadershipMonitorStarted).toBe(true);
    expect((scheduler as any).leadershipTimer).not.toBeNull();
  });

  it('is idempotent — a second startLeadershipMonitor() does not replace the timer', () => {
    scheduler.startLeadershipMonitor();
    const first = (scheduler as any).leadershipTimer;
    scheduler.startLeadershipMonitor();
    expect((scheduler as any).leadershipTimer).toBe(first);
  });
});
