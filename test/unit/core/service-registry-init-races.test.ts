/**
 * ServiceContainer — initialization/disposal races.
 *
 * `_initializeService` publishes `registration.instance` BEFORE awaiting the
 * service's own `initialize()`. That is deliberate — it is what lets a dependency
 * cycle resolve instead of deadlocking — but it means the registry briefly holds a
 * half-built service, and the two hazards below both fell out of that.
 */

import { describe, it, expect } from 'vitest';
import { ServiceContainer, ServiceLifecycle, type IService } from '../../../src/core/service-registry.ts';

/** A service whose initialize() takes a controllable amount of time. */
function makeSlowService(name: string, gate: Promise<void>) {
  const state = { initializeStarted: false, initializeFinished: false, disposed: false };
  const svc: IService & { ready: boolean } = {
    name,
    lifecycle: ServiceLifecycle.UNINITIALIZED,
    ready: false,
    async initialize() {
      state.initializeStarted = true;
      await gate;
      // Only after this does the service actually work — the analogue of
      // StateManagerService assigning its inner manager.
      svc.ready = true;
      state.initializeFinished = true;
    },
    async dispose() {
      state.disposed = true;
    },
  };
  return { svc, state };
}

describe('ServiceContainer — never hands out a half-initialized service', () => {
  it('a concurrent get() waits for the in-flight initialize() instead of receiving a partial instance', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { svc } = makeSlowService('slow', gate);

    const container = new ServiceContainer();
    container.register('slow', async () => svc);

    const first = container.get<typeof svc>('slow');
    // Let the factory resolve so `registration.instance` is published while
    // initialize() is still awaiting the gate.
    await Promise.resolve();
    await Promise.resolve();

    let secondResolved = false;
    const second = container.get<typeof svc>('slow').then((s) => { secondResolved = true; return s; });

    // The second caller must NOT have been handed the partial instance.
    await Promise.resolve();
    await Promise.resolve();
    expect(secondResolved).toBe(false);

    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(b.ready).toBe(true);
    expect(b.lifecycle).toBe(ServiceLifecycle.INITIALIZED);

    await container.disposeAll();
  });

  it('tryGet() still exposes a mid-initialization instance, because it is a lifecycle inspector', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { svc } = makeSlowService('slow', gate);

    const container = new ServiceContainer();
    container.register('slow', async () => svc);

    const pending = container.get('slow');
    await Promise.resolve();
    await Promise.resolve();

    // Filtering non-settled lifecycles out of tryGet looks like the safe choice and
    // is not: the health check resolves services through it specifically to REPORT
    // `initializing` / `disposed (not running)` without forcing initialization.
    // Returning null there would collapse every one of those states into "absent".
    // Callers that need a *ready* service use the async get(), which waits.
    const peeked = container.tryGet<typeof svc>('slow');
    expect(peeked).toBe(svc);
    expect(peeked!.lifecycle).toBe(ServiceLifecycle.INITIALIZING);

    release();
    await pending;
    expect(container.tryGet<typeof svc>('slow')!.lifecycle).toBe(ServiceLifecycle.INITIALIZED);

    await container.disposeAll();
  });

  it('does not deadlock when a service resolves a peer during its own initialize()', async () => {
    // The cycle case the early publish exists for: waiting here would hang forever.
    const container = new ServiceContainer();
    const order: string[] = [];

    const a: IService = {
      name: 'a',
      lifecycle: ServiceLifecycle.UNINITIALIZED,
      async initialize() {
        order.push('a:start');
        await container.get('b');
        order.push('a:end');
      },
    };
    const b: IService = {
      name: 'b',
      lifecycle: ServiceLifecycle.UNINITIALIZED,
      async initialize() {
        order.push('b:start');
        await container.get('a'); // back-reference into the still-initializing 'a'
        order.push('b:end');
      },
    };

    container.register('a', async () => a);
    container.register('b', async () => b);

    await expect(container.get('a')).resolves.toBe(a);
    expect(order).toEqual(['a:start', 'b:start', 'b:end', 'a:end']);

    await container.disposeAll();
  });
});

describe('ServiceContainer — disposeAll settles in-flight initializations', () => {
  it('disposes a service whose initialization completes during teardown', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { svc, state } = makeSlowService('late', gate);

    const container = new ServiceContainer();
    container.register('late', async () => {
      await gate; // factory itself is slow: instance is still null when teardown starts
      return svc;
    });

    const pending = container.get('late').catch(() => undefined);
    await Promise.resolve();

    // Teardown begins while the factory has not resolved, so the service is
    // invisible to the "instances that are non-null right now" snapshot. Without
    // awaiting in-flight work it would install itself after teardown reported
    // completion and never be disposed — a live HTTP server / ONNX session leaked
    // past shutdown.
    const disposing = container.disposeAll();
    release();
    await disposing;
    await pending;

    expect(state.disposed).toBe(true);
  });

  it('still completes teardown when an in-flight initialization never settles', async () => {
    // Never released: a service blocked on something slow must not hold shutdown
    // open forever. Bounded wait, then proceed.
    const container = new ServiceContainer();
    container.register('stuck', async () => new Promise<IService>(() => { /* never */ }));

    void container.get('stuck').catch(() => undefined);
    await Promise.resolve();

    await expect(container.disposeAll()).resolves.toBeUndefined();
  }, 20_000);
});
