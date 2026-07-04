/**
 * Regression: SchedulerService.dispose() must invalidate AND await (bounded)
 * an in-flight scheduler initialization. Previously it only shut down an
 * already-assigned scheduler; an election still in flight kept running and
 * could install a live scheduler (with a listening HTTP server) after
 * disposal, with nothing left to ever tear it down.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../../src/logger.ts', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));

import { SchedulerService } from '../../../src/core/scheduler-service.ts';
import { ServiceLifecycle } from '../../../src/core/service-registry.ts';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function settledFlag(p: Promise<unknown>) {
  const flag = { settled: false };
  p.then(() => { flag.settled = true; }, () => { flag.settled = true; });
  return flag;
}

describe('SchedulerService.dispose() — in-flight initialization', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('synchronously invalidates the init-promise slot so the factory guard trips', async () => {
    const service = new SchedulerService();
    await service.initialize();

    const gate = deferred<any>();
    service.setSchedulerInitializationPromise(gate.promise as any);

    const disposePromise = service.dispose();
    // Invalidation must happen before the first await inside dispose(),
    // otherwise the factory's superseded guard cannot see it in time.
    expect(service.getSchedulerInitializationPromise()).toBeNull();

    gate.reject(new Error('Initialization superseded'));
    await disposePromise;
    expect(service.lifecycle).toBe(ServiceLifecycle.DISPOSED);
  });

  it('awaits the in-flight init before completing disposal', async () => {
    const service = new SchedulerService();
    await service.initialize();

    const gate = deferred<any>();
    service.setSchedulerInitializationPromise(gate.promise as any);

    const disposePromise = service.dispose();
    const flag = settledFlag(disposePromise);

    // Give dispose() ample turns — it must still be waiting on the init.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(flag.settled).toBe(false);

    gate.reject(new Error('Initialization superseded'));
    await disposePromise;
    expect(service.lifecycle).toBe(ServiceLifecycle.DISPOSED);
  });

  it('bounds the wait: a wedged init cannot hang dispose() forever', async () => {
    vi.useFakeTimers();
    const service = new SchedulerService();
    await service.initialize();

    // Never settles — simulates an election stuck on the 60s browser-init lock.
    service.setSchedulerInitializationPromise(new Promise(() => {}) as any);

    const disposePromise = service.dispose();
    await vi.advanceTimersByTimeAsync(10_000);
    await disposePromise;
    expect(service.lifecycle).toBe(ServiceLifecycle.DISPOSED);
  });

  it('still shuts down a scheduler that was installed before invalidation won the race', async () => {
    const service = new SchedulerService();
    await service.initialize();

    const scheduler = { shutdown: vi.fn(async () => {}) };
    service.setSchedulerInstance(scheduler as any);
    // Successful factory inits leave the (settled) promise in the slot.
    service.setSchedulerInitializationPromise(Promise.resolve(scheduler) as any);

    await service.dispose();
    expect(scheduler.shutdown).toHaveBeenCalled();
    expect(service.getScheduler()).toBeNull();
    expect(service.lifecycle).toBe(ServiceLifecycle.DISPOSED);
  });
});
