/**
 * Unit tests for ServiceContainer / global service registry
 *
 * Each test operates on the global singleton via the exported convenience
 * functions. resetServiceContainer() is called in beforeEach/afterEach to
 * guarantee clean state between runs.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ServiceLifecycle,
  registerService,
  replaceService,
  getService,
  tryGetService,
  hasService,
  isServiceInitialized,
  disposeAllServices,
  resetServiceContainer,
  getServiceContainer,
  type IService,
} from '../../../src/core/service-registry.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeService(name: string): IService & { initCalls: number; disposeCalls: number } {
  return {
    name,
    lifecycle: ServiceLifecycle.UNINITIALIZED,
    initCalls: 0,
    disposeCalls: 0,
    async initialize() {
      this.initCalls++;
    },
    async dispose() {
      this.disposeCalls++;
    },
  };
}

function makeFactory(name: string) {
  const svc = makeService(name);
  const factory = vi.fn(() => svc);
  return { svc, factory };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
  // Reset the isDisposing flag and all registrations before every test.
  // We reach into the container to clear isDisposing in case a previous test
  // left the container mid-disposal.
  const container = getServiceContainer() as any;
  container.isDisposing = false;
  await resetServiceContainer();
});

afterEach(async () => {
  const container = getServiceContainer() as any;
  container.isDisposing = false;
  await resetServiceContainer();
});

// ---------------------------------------------------------------------------
// 1. Basic registration and retrieval + lifecycle transitions
// ---------------------------------------------------------------------------

describe('basic registration and retrieval', () => {
  it('factory is called and instance is returned by getService()', async () => {
    const { svc, factory } = makeFactory('svc-basic');
    registerService('svc-basic', factory);

    const result = await getService('svc-basic');

    expect(factory).toHaveBeenCalledOnce();
    expect(result).toBe(svc);
  });

  it('lifecycle transitions through UNINITIALIZED → INITIALIZING → INITIALIZED', async () => {
    const lifecycleStates: ServiceLifecycle[] = [];

    const svc: IService = {
      name: 'svc-lifecycle',
      lifecycle: ServiceLifecycle.UNINITIALIZED,
      async initialize() {
        lifecycleStates.push(this.lifecycle);
      },
    };

    registerService('svc-lifecycle', () => svc);
    lifecycleStates.push(svc.lifecycle); // before getService

    await getService('svc-lifecycle');
    lifecycleStates.push(svc.lifecycle); // after getService

    expect(lifecycleStates).toEqual([
      ServiceLifecycle.UNINITIALIZED,
      ServiceLifecycle.INITIALIZING,
      ServiceLifecycle.INITIALIZED,
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2. Lazy initialization
// ---------------------------------------------------------------------------

describe('lazy initialization', () => {
  it('factory is not called until getService() is invoked', () => {
    const factory = vi.fn(() => makeService('svc-lazy'));
    registerService('svc-lazy', factory);

    expect(factory).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. Singleton guarantee
// ---------------------------------------------------------------------------

describe('singleton guarantee', () => {
  it('two getService() calls return the exact same instance', async () => {
    registerService('svc-singleton', () => makeService('svc-singleton'));

    const a = await getService('svc-singleton');
    const b = await getService('svc-singleton');

    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// 4. Duplicate registration throws
// ---------------------------------------------------------------------------

describe('duplicate registration', () => {
  it('throws when registering the same name twice without allowOverwrite', () => {
    registerService('svc-dup', () => makeService('svc-dup'));

    expect(() => registerService('svc-dup', () => makeService('svc-dup'))).toThrow(
      "Service 'svc-dup' is already registered. Use registerAndReplace() to overwrite."
    );
  });
});

// ---------------------------------------------------------------------------
// 5. registerAndReplace
// ---------------------------------------------------------------------------

describe('registerAndReplace', () => {
  it('disposes the old instance and returns the new one', async () => {
    const old = makeService('svc-replace');
    registerService('svc-replace', () => old);
    await getService('svc-replace'); // initialise old instance

    const fresh = makeService('svc-replace');
    await replaceService('svc-replace', () => fresh);

    const result = await getService('svc-replace');

    expect(old.disposeCalls).toBe(1);
    expect(result).toBe(fresh);
  });
});

// ---------------------------------------------------------------------------
// 6. Disposal order (LIFO)
// ---------------------------------------------------------------------------

describe('disposeAll LIFO order', () => {
  it('disposes services C, B, A when they were registered A, B, C', async () => {
    const order: string[] = [];

    function trackedService(name: string): IService {
      return {
        name,
        lifecycle: ServiceLifecycle.UNINITIALIZED,
        dispose() {
          order.push(name);
        },
      };
    }

    registerService('svc-A', () => trackedService('svc-A'));
    registerService('svc-B', () => trackedService('svc-B'));
    registerService('svc-C', () => trackedService('svc-C'));

    await getService('svc-A');
    await getService('svc-B');
    await getService('svc-C');

    await disposeAllServices();

    expect(order).toEqual(['svc-C', 'svc-B', 'svc-A']);
  });
});

// ---------------------------------------------------------------------------
// 7. reset()
// ---------------------------------------------------------------------------

describe('reset', () => {
  it('disposes existing instances and allows re-registration of the same name', async () => {
    const old = makeService('svc-reset');
    registerService('svc-reset', () => old);
    await getService('svc-reset');

    await resetServiceContainer();

    // Should not throw — the name is free again
    const fresh = makeService('svc-reset');
    expect(() => registerService('svc-reset', () => fresh)).not.toThrow();

    // Old instance should have been disposed
    expect(old.disposeCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 8. tryGetService
// ---------------------------------------------------------------------------

describe('tryGetService', () => {
  it('returns null before the service is initialized', () => {
    registerService('svc-try', () => makeService('svc-try'));

    expect(tryGetService('svc-try')).toBeNull();
  });

  it('returns the instance after getService() has been called', async () => {
    const { svc } = makeFactory('svc-try2');
    registerService('svc-try2', () => svc);
    await getService('svc-try2');

    expect(tryGetService('svc-try2')).toBe(svc);
  });
});

// ---------------------------------------------------------------------------
// 9. hasService / isServiceInitialized
// ---------------------------------------------------------------------------

describe('hasService and isServiceInitialized', () => {
  it('hasService is false before registration and true after', () => {
    expect(hasService('svc-has')).toBe(false);
    registerService('svc-has', () => makeService('svc-has'));
    expect(hasService('svc-has')).toBe(true);
  });

  it('isServiceInitialized is false before getService() and true after', async () => {
    registerService('svc-init-check', () => makeService('svc-init-check'));

    expect(isServiceInitialized('svc-init-check')).toBe(false);
    await getService('svc-init-check');
    expect(isServiceInitialized('svc-init-check')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 10. Error in factory propagates and allows retry
// ---------------------------------------------------------------------------

describe('factory error handling', () => {
  it('rejects getService() with the factory error', async () => {
    const boom = new Error('factory exploded');
    registerService('svc-err', () => { throw boom; });

    await expect(getService('svc-err')).rejects.toThrow('factory exploded');
  });

  it('clears initializationPromise so a subsequent call retries the factory', async () => {
    let callCount = 0;
    const goodSvc = makeService('svc-retry');

    registerService('svc-retry', () => {
      callCount++;
      if (callCount === 1) throw new Error('first call fails');
      return goodSvc;
    });

    await expect(getService('svc-retry')).rejects.toThrow('first call fails');
    const result = await getService('svc-retry');

    expect(callCount).toBe(2);
    expect(result).toBe(goodSvc);
  });
});

// ---------------------------------------------------------------------------
// 11. Concurrent getService() calls — single factory invocation
// ---------------------------------------------------------------------------

describe('concurrent getService() calls', () => {
  it('invokes the factory exactly once when two calls are made simultaneously', async () => {
    let factoryCallCount = 0;

    registerService('svc-concurrent', async () => {
      factoryCallCount++;
      // Simulate async work so the second call arrives before this resolves
      await new Promise<void>(resolve => setTimeout(resolve, 10));
      return makeService('svc-concurrent');
    });

    const [a, b] = await Promise.all([
      getService('svc-concurrent'),
      getService('svc-concurrent'),
    ]);

    expect(factoryCallCount).toBe(1);
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// 12. disposeAll() during disposal is a no-op
// ---------------------------------------------------------------------------

describe('disposeAll during active disposal', () => {
  it('does not throw and does not double-dispose when called re-entrantly', async () => {
    let disposeCount = 0;

    const svc: IService = {
      name: 'svc-reentrant',
      lifecycle: ServiceLifecycle.UNINITIALIZED,
      async dispose() {
        disposeCount++;
        // Trigger a second disposeAll while already disposing
        await disposeAllServices();
      },
    };

    registerService('svc-reentrant', () => svc);
    await getService('svc-reentrant');

    await expect(disposeAllServices()).resolves.toBeUndefined();

    // The inner call was a no-op; dispose ran exactly once
    expect(disposeCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 13. getService() during disposal throws
// ---------------------------------------------------------------------------

describe('getService during disposal', () => {
  it('throws a meaningful error when the container is disposing', async () => {
    registerService('svc-disposing', () => makeService('svc-disposing'));

    // Manually set the flag to simulate mid-disposal state
    const container = getServiceContainer() as any;
    container.isDisposing = true;

    await expect(getService('svc-disposing')).rejects.toThrow(
      "Cannot get service 'svc-disposing' during container disposal"
    );
  });
});
