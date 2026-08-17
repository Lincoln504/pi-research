/**
 * Regression: forceSchedulerRestart force-tore the shared browser-init lock out from
 * under a live holder.
 *
 * The lock serializes leader election and browser-server startup across every
 * getScheduler() caller in the process. forceSchedulerRestart never acquires it — yet
 * it disposed it in an unconditional `finally`, and FileLockService.dispose() is not a
 * release: it drains for CLEANUP_DRAIN_TIMEOUT_MS (5s), then FORCES the teardown,
 * unlinking the lock file and retiring the instance. Launching a browser server takes
 * longer than that drain, and the retry paths in task-execution-service call
 * forceSchedulerRestart mid-run precisely when an init is likely in flight.
 *
 * The victim's critical section is not cancelled by the teardown — it keeps running.
 * The next getBrowserInitLock() then builds a FRESH instance (new uuid, new FIFO
 * queue) over the now-unlinked path, so it acquires immediately. Two concurrent
 * browser inits, two elections, two listening servers.
 *
 * The lock is path-scoped and version-independent, so a restart does not invalidate
 * it; only container teardown (SchedulerFactoryService.dispose) should retire it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../src/logger.ts', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));
vi.mock('../../../../src/utils/metrics.ts', () => ({
  metrics: { increment: vi.fn(), setGauge: vi.fn(), observe: vi.fn(), session: { increment: vi.fn(), setGauge: vi.fn(), observe: vi.fn() } },
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

/** Records dispose() and whether a critical section was in flight when it landed. */
const lockEvents: string[] = [];
let heldDepth = 0;

vi.mock('../../../../src/infrastructure/file-lock-service.ts', () => ({
  FileLockService: class {
    async initialize() { lockEvents.push('initialize'); }
    async dispose() { lockEvents.push(heldDepth > 0 ? 'dispose-while-held' : 'dispose-idle'); }
    async withLock<T>(fn: () => Promise<T>): Promise<T> {
      heldDepth++;
      try {
        return await fn();
      } finally {
        heldDepth--;
      }
    }
  },
}));
vi.mock('../../../../src/infrastructure/browser/config.ts', () => ({
  generateSchedulerVersion: vi.fn(() => 'test-version'),
}));
vi.mock('../../../../src/infrastructure/browser/browser-server.ts', () => ({
  getBrowserServerAuthSecret: vi.fn(() => 'test-secret'),
}));
vi.mock('../../../../src/infrastructure/browser/browser-client.ts', () => ({
  BrowserClient: class { shutdown = vi.fn(async () => {}); },
}));
vi.mock('../../../../src/infrastructure/browser/browser-task-scheduler.ts', () => ({
  BrowserTaskScheduler: class {},
}));

import { getScheduler, forceSchedulerRestart } from '../../../../src/infrastructure/browser/scheduler-factory.ts';
import { ServiceNames } from '../../../../src/core/interfaces/service-names.ts';

function makeSchedulerInternals() {
  let initPromise: Promise<unknown> | null = null;
  let instance: unknown = null;
  return {
    getSchedulerInstance: () => instance,
    setSchedulerInstance: vi.fn((v: unknown) => { instance = v; }),
    getSchedulerVersion: () => null,
    setSchedulerVersion: vi.fn(),
    getSchedulerInitializationPromise: () => initPromise,
    setSchedulerInitializationPromise: vi.fn((p: Promise<unknown> | null) => { initPromise = p; }),
    getPendingShutdownPromise: () => null,
    setPendingShutdownPromise: vi.fn(),
    isSchedulerRestartInProgress: () => false,
    setSchedulerRestartInProgress: vi.fn(),
  };
}

describe('forceSchedulerRestart — the shared browser-init lock', () => {
  beforeEach(() => {
    lockEvents.length = 0;
    heldDepth = 0;
  });

  it('does not tear the lock away from an in-flight initialization', async () => {
    // Hold the critical section open at its first await, the way a real browser
    // launch does for tens of seconds.
    let releaseCriticalSection!: () => void;
    const criticalSectionParked = new Promise<void>((r) => { releaseCriticalSection = r; });
    let entered!: () => void;
    const hasEntered = new Promise<void>((r) => { entered = r; });

    const internals = makeSchedulerInternals();
    const stateManager = {
      // Only the INIT's read parks. forceSchedulerRestart reads the same state
      // manager, and parking that call too would just deadlock the test.
      getBrowserServer: vi.fn(async () => {
        if (stateManager.getBrowserServer.mock.calls.length === 1) {
          entered();
          await criticalSectionParked;
        }
        // Report no prior leader so the init would go on to elect; it never gets
        // that far in this test, which is the point — it is still holding the lock.
        return null;
      }),
      isPidAlive: vi.fn(async () => false),
      readState: vi.fn(async () => ({})),
      clearBrowserServer: vi.fn(async () => {}),
    };
    const container: any = {
      isDisposing: false,
      __services: {
        [ServiceNames.SCHEDULER]: internals,
        [ServiceNames.STATE_MANAGER]: stateManager,
        [ServiceNames.STATE_PATH_CONFIGURATION]: { getLockDirPath: () => '/tmp/pi-research-test-locks' },
        [ServiceNames.PROCESS_LIFECYCLE]: { getCurrentProcessStartTime: async () => 1 },
      },
    };

    const initInFlight = getScheduler(undefined, container).catch(() => { /* superseded is fine */ });
    await hasEntered;
    expect(heldDepth).toBe(1);

    await forceSchedulerRestart(false, container);

    // The whole defect in one assertion: nothing may retire the lock while a peer
    // holds it. Before the fix this recorded 'dispose-while-held'.
    expect(lockEvents).not.toContain('dispose-while-held');

    releaseCriticalSection();
    await initInFlight;
  });

  it('leaves the lock instance usable for the next initialization', async () => {
    // A restart must not retire the lock at all: it is path-scoped and does not
    // depend on the scheduler version, and disposing it means the NEXT caller
    // constructs a second instance with its own uuid and FIFO queue — which is the
    // mechanism by which two inits run at once even without a live holder.
    const internals = makeSchedulerInternals();
    const container: any = {
      isDisposing: false,
      __services: {
        [ServiceNames.SCHEDULER]: internals,
        [ServiceNames.STATE_MANAGER]: {
          getBrowserServer: vi.fn(async () => null),
          isPidAlive: vi.fn(async () => false),
          readState: vi.fn(async () => ({})),
          clearBrowserServer: vi.fn(async () => {}),
        },
        [ServiceNames.STATE_PATH_CONFIGURATION]: { getLockDirPath: () => '/tmp/pi-research-test-locks-2' },
        [ServiceNames.PROCESS_LIFECYCLE]: { getCurrentProcessStartTime: async () => 1 },
      },
    };

    await getScheduler(undefined, container).catch(() => { /* the fake scheduler cannot start a server */ });
    const initializesBefore = lockEvents.filter((e) => e === 'initialize').length;
    expect(initializesBefore).toBe(1);

    await forceSchedulerRestart(false, container);
    internals.setSchedulerInitializationPromise(null);
    await getScheduler(undefined, container).catch(() => { /* same */ });

    // Still one construction: the cached instance was reused, not rebuilt.
    expect(lockEvents.filter((e) => e === 'initialize')).toHaveLength(1);
    expect(lockEvents).not.toContain('dispose-idle');
  });
});
