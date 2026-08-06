/**
 * Regression: forceSchedulerRestart's dead-leader clearBrowserServer() call
 * had no compare-and-delete (CAS) semantics — unlike its sibling
 * clearEmbeddingServer(), which only deletes when the caller's expected
 * identity still matches what is actually stored.
 *
 * forceSchedulerRestart reads serverInfo, decides (outside any lock) that the
 * registrant is dead, then calls clearBrowserServer() unconditionally. If, in
 * that exact window, another process independently detects the same dead
 * leader and completes its OWN (properly locked) election, it commits itself
 * as the new live leader. forceSchedulerRestart's subsequent unconditional
 * clear then wipes that brand-new, legitimate registration: the new leader
 * keeps running (live worker pool, open HTTP server) but is now undiscoverable
 * via state, so the next getScheduler() caller elects a second, fully
 * redundant leader.
 *
 * This test simulates the race by mutating the fake state's browserServer
 * entry to a NEW registration from inside the isPidAlive() liveness check —
 * exactly the window between forceSchedulerRestart's read and its clear call.
 * With the fix, clearBrowserServer is called with the stale (dead) owner as
 * `expected`, and the fake store's CAS logic (mirroring
 * StateBrowserManager.clearBrowserServer) refuses to delete a non-matching
 * entry, so the new leader's registration survives.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../../src/logger.ts', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));
vi.mock('../../../../src/utils/metrics.ts', () => ({
  metrics: { increment: vi.fn(), setGauge: vi.fn(), observe: vi.fn() },
}));
vi.mock('../../../../src/core/service-registry.ts', () => ({
  getService: vi.fn(async (name: string, _ctx: any, container: any) => {
    const svc = container?.__services?.[name];
    if (!svc) throw new Error(`No fake service registered for '${name}'`);
    return svc;
  }),
  tryGetService: vi.fn((name: string, container: any) => container?.__services?.[name] ?? null),
  getServiceContainer: vi.fn(() => ({ __global: true })),
}));
vi.mock('../../../../src/infrastructure/file-lock-service.ts', () => ({
  FileLockService: class {
    async initialize() {}
    async dispose() {}
    async withLock<T>(fn: () => Promise<T>): Promise<T> { return fn(); }
  },
}));
vi.mock('../../../../src/infrastructure/browser/config.ts', () => ({
  generateSchedulerVersion: vi.fn(() => 'test-version'),
}));
vi.mock('../../../../src/infrastructure/browser/browser-server.ts', () => ({
  getBrowserServerAuthSecret: vi.fn(() => 'test-secret'),
}));
vi.mock('../../../../src/infrastructure/browser/browser-client.ts', () => ({
  BrowserClient: class {
    shutdown = vi.fn(async () => {});
  },
}));
vi.mock('../../../../src/infrastructure/browser/browser-task-scheduler.ts', () => ({
  BrowserTaskScheduler: class {},
}));

import { forceSchedulerRestart } from '../../../../src/infrastructure/browser/scheduler-factory.ts';
import { ServiceNames } from '../../../../src/core/interfaces/service-names.ts';

type FakeBrowserServer = { pid: number; schedulerId: string; port: number; startTime: number };

function makeSchedulerInternals() {
  return {
    getSchedulerInstance: () => null,
    setSchedulerInstance: vi.fn(),
    getSchedulerVersion: () => null,
    setSchedulerVersion: vi.fn(),
    getSchedulerInitializationPromise: () => null,
    setSchedulerInitializationPromise: vi.fn(),
    getPendingShutdownPromise: () => null,
    setPendingShutdownPromise: vi.fn(),
    isSchedulerRestartInProgress: () => false,
    setSchedulerRestartInProgress: vi.fn(),
  };
}

/**
 * Mirrors StateBrowserManager.clearBrowserServer's compare-and-delete: with
 * `expected` supplied, the entry is only removed if it still matches what the
 * caller believes is stored; an unconditional call (no `expected`) always
 * deletes, reproducing today's unsafe behavior.
 */
function makeFakeBrowserStateStore(initial: FakeBrowserServer) {
  let entry: FakeBrowserServer | null = initial;
  return {
    get: () => entry,
    set: (v: FakeBrowserServer | null) => { entry = v; },
    clear: (expected?: { pid?: number; schedulerId?: string }) => {
      if (entry && expected !== undefined) {
        if (expected.schedulerId !== undefined && entry.schedulerId !== expected.schedulerId) return;
        if (expected.pid !== undefined && entry.pid !== expected.pid) return;
      }
      entry = null;
    },
  };
}

describe('forceSchedulerRestart — clearBrowserServer TOCTOU race', () => {
  it('does not wipe a new leader that claimed the slot between the dead-leader read and the clear', async () => {
    const deadLeader: FakeBrowserServer = { pid: 111, schedulerId: 'dead-sched', port: 5000, startTime: 100 };
    const newLeader: FakeBrowserServer = { pid: 222, schedulerId: 'new-sched', port: 6000, startTime: 200 };
    const store = makeFakeBrowserStateStore(deadLeader);

    const internals = makeSchedulerInternals();
    const stateManager = {
      getBrowserServer: vi.fn(async () => store.get()),
      isPidAlive: vi.fn(async () => {
        // Simulate a concurrent election completing in the exact window
        // between forceSchedulerRestart's liveness read and its clear call:
        // another process independently detects the same dead leader, wins
        // its own (properly locked) election, and publishes a fresh
        // registration before this function gets to clear anything.
        store.set(newLeader);
        return false; // the leader forceSchedulerRestart read about IS dead
      }),
      readState: vi.fn(async () => ({})),
      clearBrowserServer: vi.fn(async (expected?: { pid?: number; schedulerId?: string }) => {
        store.clear(expected);
      }),
    };
    const container: any = {
      isDisposing: false,
      __services: {
        [ServiceNames.SCHEDULER]: internals,
        [ServiceNames.STATE_MANAGER]: stateManager,
      },
    };

    await forceSchedulerRestart(false, container);

    expect(stateManager.clearBrowserServer).toHaveBeenCalled();
    // The bug: an unconditional clear wipes whatever is stored *now*, not
    // what was read. The fix: clearBrowserServer is called with the stale
    // (dead) owner as `expected`, so the new leader's registration survives.
    expect(store.get()).toEqual(newLeader);
  });
});
