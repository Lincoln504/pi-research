/**
 * Regression: teardown racing an in-flight scheduler election must not
 * resurrect a live BrowserTaskScheduler that nothing will ever shut down.
 *
 * The election in scheduler-factory.ts can take up to ~60s (browser-init
 * lock + startServer). Previously its "superseded" guard only detected
 * forceSchedulerRestart (init-promise swap); container disposal never
 * tripped it, so quit/shutdown during the election installed a freshly
 * created scheduler — with a ref'd, listening HTTP server — onto a
 * disposing container, holding the event loop open forever on the SDK path.
 *
 * The factory now consults isSuperseded() (container.isDisposing OR
 * init-promise slot no longer holds this init) after every await point,
 * and shuts down its product instead of installing it.
 */

import { describe, it, expect, vi } from 'vitest';

const h = vi.hoisted(() => {
  function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  }
  const createdSchedulers: any[] = [];
  return { deferred, createdSchedulers };
});

vi.mock('../../../src/logger.ts', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));
vi.mock('../../../src/utils/metrics.ts', () => ({
  metrics: { increment: vi.fn(), setGauge: vi.fn(), observe: vi.fn() },
}));
vi.mock('../../../src/core/service-registry.ts', () => ({
  getService: vi.fn(async (name: string, _ctx: any, container: any) => {
    const svc = container?.__services?.[name];
    if (!svc) throw new Error(`No fake service registered for '${name}'`);
    return svc;
  }),
  tryGetService: vi.fn((name: string, container: any) => container?.__services?.[name] ?? null),
  getServiceContainer: vi.fn(() => ({ __global: true })),
}));
vi.mock('../../../src/infrastructure/file-lock-service.ts', () => ({
  FileLockService: class {
    async initialize() {}
    async dispose() {}
    async withLock<T>(fn: () => Promise<T>): Promise<T> { return fn(); }
  },
}));
vi.mock('../../../src/infrastructure/browser/config.ts', () => ({
  generateSchedulerVersion: vi.fn(() => 'test-version'),
}));
vi.mock('../../../src/infrastructure/browser/browser-server.ts', () => ({
  getBrowserServerAuthSecret: vi.fn(() => 'test-secret'),
}));
vi.mock('../../../src/infrastructure/browser/browser-client.ts', () => ({
  BrowserClient: class {
    shutdown = vi.fn(async () => {});
  },
}));
vi.mock('../../../src/infrastructure/browser/browser-task-scheduler.ts', () => ({
  BrowserTaskScheduler: class {
    schedulerId: string;
    startServerGate = h.deferred<number>();
    shutdown = vi.fn(async () => {});
    startLeadershipMonitor = vi.fn();
    constructor(schedulerId: string) {
      this.schedulerId = schedulerId;
      h.createdSchedulers.push(this);
    }
    startServer(): Promise<number> {
      return this.startServerGate.promise;
    }
  },
}));

import { getScheduler } from '../../../src/infrastructure/browser/scheduler-factory.ts';
import { ServiceNames } from '../../../src/core/interfaces/service-names.ts';

function makeSchedulerInternals() {
  let instance: any = null;
  let version: string | null = null;
  let initPromise: any = null;
  return {
    getSchedulerInstance: () => instance,
    setSchedulerInstance: (i: any) => { instance = i; },
    getSchedulerVersion: () => version,
    setSchedulerVersion: (v: string | null) => { version = v; },
    getSchedulerInitializationPromise: () => initPromise,
    setSchedulerInitializationPromise: (p: any) => { initPromise = p; },
    getPendingShutdownPromise: () => null,
    setPendingShutdownPromise: vi.fn(),
    isSchedulerRestartInProgress: () => false,
    setSchedulerRestartInProgress: vi.fn(),
  };
}

function makeHarness(opts: { updateStateGate?: { promise: Promise<void> } } = {}) {
  const internals = makeSchedulerInternals();
  const stateManager = {
    getBrowserServer: vi.fn(async () => null),
    isPidAlive: vi.fn(async () => false),
    readState: vi.fn(async () => ({})),
    clearBrowserServer: vi.fn(async () => {}),
    updateState: vi.fn(async (fn: (state: any) => Promise<any>) => {
      if (opts.updateStateGate) await opts.updateStateGate.promise;
      return fn({});
    }),
  };
  const container: any = {
    isDisposing: false,
    __services: {
      [ServiceNames.SCHEDULER]: internals,
      [ServiceNames.STATE_MANAGER]: stateManager,
      [ServiceNames.STATE_PATH_CONFIGURATION]: { getLockDirPath: () => '/nonexistent-not-used' },
      [ServiceNames.PROCESS_LIFECYCLE]: {},
    },
  };
  return { internals, stateManager, container };
}

async function waitForSchedulerCreation(baseline: number) {
  await vi.waitFor(() => {
    expect(h.createdSchedulers.length).toBeGreaterThan(baseline);
  });
  return h.createdSchedulers[h.createdSchedulers.length - 1];
}

describe('scheduler-factory — dispose during election', () => {
  it('container disposal during startServer(): product is shut down, never installed, never registered as leader', async () => {
    const { internals, stateManager, container } = makeHarness();
    const baseline = h.createdSchedulers.length;

    const promise = getScheduler(undefined, container);
    const scheduler = await waitForSchedulerCreation(baseline);

    // Teardown wins the race while the HTTP server is starting.
    container.isDisposing = true;
    scheduler.startServerGate.resolve(4321);

    await expect(promise).rejects.toThrow('Initialization superseded');
    expect(scheduler.shutdown).toHaveBeenCalled();
    expect(internals.getSchedulerInstance()).toBeNull();
    expect(scheduler.startLeadershipMonitor).not.toHaveBeenCalled();
    // Must not have registered the doomed server as election leader.
    expect(stateManager.updateState).not.toHaveBeenCalled();
  });

  it('init-promise invalidation (SchedulerService.dispose) during startServer(): product is shut down, never installed', async () => {
    const { internals, stateManager, container } = makeHarness();
    const baseline = h.createdSchedulers.length;

    const promise = getScheduler(undefined, container);
    const scheduler = await waitForSchedulerCreation(baseline);

    // SchedulerService.dispose() invalidates the slot (without container disposal).
    internals.setSchedulerInitializationPromise(null);
    scheduler.startServerGate.resolve(4321);

    await expect(promise).rejects.toThrow('Initialization superseded');
    expect(scheduler.shutdown).toHaveBeenCalled();
    expect(internals.getSchedulerInstance()).toBeNull();
    expect(stateManager.updateState).not.toHaveBeenCalled();
  });

  it('disposal after winning the election: pool shut down instead of installed, monitor never armed', async () => {
    const updateStateGate = h.deferred<void>();
    const { internals, container } = makeHarness({ updateStateGate });
    const baseline = h.createdSchedulers.length;

    const promise = getScheduler(undefined, container);
    const scheduler = await waitForSchedulerCreation(baseline);
    scheduler.startServerGate.resolve(4321);

    // Let the init proceed into updateState, then dispose while it is pending.
    await vi.waitFor(() => {
      expect(container.__services[ServiceNames.STATE_MANAGER].updateState).toHaveBeenCalled();
    });
    container.isDisposing = true;
    updateStateGate.resolve();

    await expect(promise).rejects.toThrow('Initialization superseded');
    expect(scheduler.shutdown).toHaveBeenCalled();
    expect(internals.getSchedulerInstance()).toBeNull();
    expect(scheduler.startLeadershipMonitor).not.toHaveBeenCalled();
  });

  it('disposal before startServer(): no scheduler (and no server) is ever created', async () => {
    const getBrowserServerGate = h.deferred<null>();
    const { internals, container } = makeHarness();
    container.__services[ServiceNames.STATE_MANAGER].getBrowserServer =
      vi.fn(() => getBrowserServerGate.promise);
    const baseline = h.createdSchedulers.length;

    const promise = getScheduler(undefined, container);
    container.isDisposing = true;
    getBrowserServerGate.resolve(null);

    await expect(promise).rejects.toThrow('Initialization superseded');
    expect(h.createdSchedulers.length).toBe(baseline);
    expect(internals.getSchedulerInstance()).toBeNull();
  });

  it('no disposal: election completes, scheduler installed, monitor armed, nothing shut down', async () => {
    const { internals, container } = makeHarness();
    const baseline = h.createdSchedulers.length;

    const promise = getScheduler(undefined, container);
    const scheduler = await waitForSchedulerCreation(baseline);
    scheduler.startServerGate.resolve(4321);

    const result = await promise;
    expect(result).toBe(scheduler);
    expect(internals.getSchedulerInstance()).toBe(scheduler);
    expect(internals.getSchedulerVersion()).toBe('test-version');
    expect(scheduler.startLeadershipMonitor).toHaveBeenCalled();
    expect(scheduler.shutdown).not.toHaveBeenCalled();
  });
});
