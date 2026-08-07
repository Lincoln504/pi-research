/**
 * ServiceContainer — clear()/replace() disposal races, and the ctx-reinit
 * failure asymmetry.
 *
 * clear()/replace() used to dispose registration.instance without publishing
 * any marker a concurrent get() could see — get() only ever checked
 * registration.initializationPromise. A get() arriving while dispose() was
 * still awaiting (registration.instance not yet nulled) would either hand the
 * caller a reference to the instance currently being torn down, or — if a ctx
 * was passed — call initialize(ctx) on that same instance while its dispose()
 * was still running. registration.disposalPromise now closes this: get()
 * awaits it before touching registration.instance.
 *
 * Separately, get()'s ctx-reinit branch (an already-initialized instance
 * re-run through initialize(ctx) — the mode/cwd re-scope path) used to leave
 * registration.instance pointing at the same object even when that
 * initialize(ctx) call threw, unlike a fresh _initializeService() failure
 * (which nulls registration.instance so the next get() rebuilds cleanly).
 */

import { describe, it, expect } from 'vitest';
import { ServiceContainer, ServiceLifecycle, type IService } from '../../../src/core/service-registry.ts';

/** A service whose dispose() takes a controllable amount of time. */
function makeSlowDisposeService(name: string, gate: Promise<void>) {
  const state = { disposeStarted: false, disposeFinished: false, initializeCalls: 0 };
  const svc: IService = {
    name,
    lifecycle: ServiceLifecycle.UNINITIALIZED,
    async initialize() {
      state.initializeCalls++;
    },
    async dispose() {
      state.disposeStarted = true;
      await gate;
      state.disposeFinished = true;
    },
  };
  return { svc, state };
}

describe('ServiceContainer — get() vs a concurrent clear()', () => {
  it('does not hand back the instance currently being disposed, nor re-initialize it via a ctx call', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { svc: firstSvc, state: firstState } = makeSlowDisposeService('svc', gate);

    const container = new ServiceContainer();
    let buildCount = 0;
    const secondSvc: IService = {
      name: 'svc',
      lifecycle: ServiceLifecycle.UNINITIALIZED,
      async initialize() {},
    };
    container.register('svc', async () => (buildCount++ === 0 ? firstSvc : secondSvc));

    const first = await container.get<IService>('svc');
    expect(first).toBe(firstSvc);
    // One call from the initial construction above; the assertions below
    // check this does NOT increase — i.e. no re-init is attempted on the
    // instance while it's mid-disposal.
    const initializeCallsAfterConstruction = firstState.initializeCalls;
    expect(initializeCallsAfterConstruction).toBe(1);

    const clearing = container.clear('svc');
    // Let clear() reach and start awaiting dispose().
    await Promise.resolve();
    await Promise.resolve();
    expect(firstState.disposeStarted).toBe(true);
    expect(firstState.disposeFinished).toBe(false);

    // A concurrent get() WITH a ctx — the branch that would call
    // initialize(ctx) on registration.instance if it were still visible.
    let secondResolved = false;
    const second = container.get<IService>('svc', { some: 'ctx' }).then((s) => {
      secondResolved = true;
      return s;
    });

    await Promise.resolve();
    await Promise.resolve();
    // Must NOT have resolved (and therefore cannot have re-initialized the
    // instance still mid-dispose) while clear() is still in flight.
    expect(secondResolved).toBe(false);
    expect(firstState.initializeCalls).toBe(initializeCallsAfterConstruction);

    release();
    await clearing;
    const result = await second;

    // Disposed exactly once — never re-initialized mid-teardown.
    expect(firstState.disposeFinished).toBe(true);
    expect(firstState.initializeCalls).toBe(initializeCallsAfterConstruction);
    // The concurrent get() got a FRESH instance built after clear() actually
    // finished, not the one that was being torn down.
    expect(result).toBe(secondSvc);
    expect(result).not.toBe(firstSvc);

    await container.disposeAll();
  });
});

describe('ServiceContainer — get() vs a concurrent replace()', () => {
  it('a concurrent get() waits out replace() and receives the new instance, never the one being replaced mid-dispose', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { svc: oldSvc, state: oldState } = makeSlowDisposeService('svc', gate);

    const container = new ServiceContainer();
    container.register('svc', async () => oldSvc);
    await container.get<IService>('svc');

    const newSvc: IService = { name: 'svc', lifecycle: ServiceLifecycle.UNINITIALIZED };
    const replacing = container.replace('svc', newSvc);
    await Promise.resolve();
    await Promise.resolve();
    expect(oldState.disposeStarted).toBe(true);

    let resolved = false;
    const pending = container.get<IService>('svc').then((s) => { resolved = true; return s; });
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);

    release();
    await replacing;
    const result = await pending;

    expect(result).toBe(newSvc);
    expect(oldState.disposeFinished).toBe(true);

    await container.disposeAll();
  });
});

describe('ServiceContainer — ctx-reinit failure resets the instance', () => {
  it('nulls registration.instance on a failed initialize(ctx) re-init, mirroring a fresh-init failure', async () => {
    const container = new ServiceContainer();
    let reinitAttempt = 0;
    const svc: IService = {
      name: 'svc',
      lifecycle: ServiceLifecycle.UNINITIALIZED,
      async initialize(ctx?: any) {
        if (ctx) {
          reinitAttempt++;
          throw new Error('re-init failed mid-rebuild');
        }
      },
    };
    let buildCount = 0;
    container.register('svc', async () => { buildCount++; return svc; });

    const first = await container.get<IService>('svc');
    expect(first).toBe(svc);
    expect(buildCount).toBe(1);

    // Re-init with a ctx: throws.
    await expect(container.get<IService>('svc', { cwd: '/elsewhere' })).rejects.toThrow('re-init failed mid-rebuild');
    expect(reinitAttempt).toBe(1);

    // Unlike the pre-fix behavior (registration.instance left pointing at the
    // same now-possibly-inconsistent object), the registry must no longer
    // consider this instance live.
    expect(container.tryGet('svc')).toBeNull();

    // The next plain get() (no ctx) rebuilds cleanly via the factory rather
    // than handing back the broken object.
    const rebuilt = await container.get<IService>('svc');
    expect(buildCount).toBe(2);
    expect(rebuilt).toBe(svc);

    await container.disposeAll();
  });

  it('a successful initialize(ctx) re-init still returns the same instance (no change in the happy path)', async () => {
    const container = new ServiceContainer();
    let reinitCalls = 0;
    const svc: IService = {
      name: 'svc',
      lifecycle: ServiceLifecycle.UNINITIALIZED,
      async initialize(ctx?: any) {
        if (ctx) reinitCalls++;
      },
    };
    container.register('svc', async () => svc);

    const first = await container.get<IService>('svc');
    const second = await container.get<IService>('svc', { cwd: '/elsewhere' });

    expect(first).toBe(svc);
    expect(second).toBe(svc);
    expect(reinitCalls).toBe(1);
    expect(container.tryGet('svc')).toBe(svc);

    await container.disposeAll();
  });
});
