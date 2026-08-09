/**
 * ServiceContainer — disposeAll() vs a concurrent clear()/replace() disposal.
 *
 * _runDisposeAll() snapshots `activeServices` from `registration.instance !==
 * null` without first waiting for a clear()/replace() disposal that is
 * already in flight for that same service. If that disposal has called
 * instance.dispose() but not yet nulled/replaced registration.instance (still
 * awaiting), the snapshot includes the service, and the DAG-teardown loop
 * calls instance.dispose() a SECOND time on the very same instance,
 * concurrently with clear()/replace()'s own in-flight call.
 *
 * get() already guards this same window via registration.disposalPromise
 * (see service-registry-clear-replace-races.test.ts); disposeAll() needed
 * the identical wait before reading registration.instance.
 */

import { describe, it, expect } from 'vitest';
import { ServiceContainer, ServiceLifecycle, type IService } from '../../../src/core/service-registry.ts';

/** A service whose dispose() counts invocations and blocks on a gate. */
function makeGatedDisposeService(name: string, gate: Promise<void>) {
  const state = { disposeCalls: 0, disposeStarted: false };
  const svc: IService = {
    name,
    lifecycle: ServiceLifecycle.UNINITIALIZED,
    async dispose() {
      state.disposeCalls++;
      state.disposeStarted = true;
      await gate;
    },
  };
  return { svc, state };
}

describe('ServiceContainer — disposeAll() vs a concurrent clear()', () => {
  it('does not call dispose() a second time on an instance clear() is already tearing down', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { svc, state } = makeGatedDisposeService('svc', gate);

    const container = new ServiceContainer({ enableLogging: false });
    container.register('svc', async () => svc);
    await container.get<IService>('svc');

    const clearing = container.clear('svc');
    // Let clear() reach and start awaiting dispose().
    await Promise.resolve();
    await Promise.resolve();
    expect(state.disposeStarted).toBe(true);
    expect(state.disposeCalls).toBe(1);

    // disposeAll() starts while clear()'s own disposal is still in flight.
    const disposing = container.disposeAll();
    await Promise.resolve();
    await Promise.resolve();

    release();
    await Promise.all([clearing, disposing]);

    // Exactly one dispose() call total — disposeAll() must not have
    // independently invoked dispose() on the same instance clear() was
    // already tearing down.
    expect(state.disposeCalls).toBe(1);
  });
});

describe('ServiceContainer — disposeAll() vs a concurrent replace()', () => {
  it('disposes the NEW instance exactly once, and never re-touches the old one replace() already tore down', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { svc: oldSvc, state: oldState } = makeGatedDisposeService('svc', gate);

    const container = new ServiceContainer({ enableLogging: false });
    container.register('svc', async () => oldSvc);
    await container.get<IService>('svc');

    let newDisposeCalls = 0;
    const newSvc: IService = {
      name: 'svc',
      lifecycle: ServiceLifecycle.UNINITIALIZED,
      async dispose() { newDisposeCalls++; },
    };

    const replacing = container.replace('svc', newSvc);
    await Promise.resolve();
    await Promise.resolve();
    expect(oldState.disposeStarted).toBe(true);

    const disposing = container.disposeAll();
    await Promise.resolve();
    await Promise.resolve();

    release();
    await Promise.all([replacing, disposing]);

    // Old instance disposed exactly once (by replace() itself).
    expect(oldState.disposeCalls).toBe(1);
    // New instance — installed by replace() once it settled — disposed
    // exactly once by the teardown that ran after it, never skipped and
    // never double-invoked.
    expect(newDisposeCalls).toBe(1);
  });
});
