/**
 * Service Registry Disposal Tests
 *
 * Tests that verify services can be re-accessed after disposal.
 * This is critical for the fix where disposeAll() no longer clears registrations.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  registerService,
  getService,
  tryGetService,
  disposeAllServices,
  resetServiceContainer,
  ServiceLifecycle,
} from '../../../src/core/service-registry.ts';

// Mock service for testing
class MockService {
  readonly name = 'mock-service';
  lifecycle = ServiceLifecycle.UNINITIALIZED;
  initialized = false;
  disposed = false;

  async initialize(): Promise<void> {
    this.lifecycle = ServiceLifecycle.INITIALIZING;
    await new Promise(resolve => setTimeout(resolve, 10));
    this.initialized = true;
    this.lifecycle = ServiceLifecycle.INITIALIZED;
  }

  async dispose(): Promise<void> {
    this.lifecycle = ServiceLifecycle.DISPOSING;
    await new Promise(resolve => setTimeout(resolve, 5));
    this.disposed = true;
    this.lifecycle = ServiceLifecycle.DISPOSED;
  }
}

describe('Service Registry Disposal Behavior', () => {
  afterEach(async () => {
    // Clean up after each test
    await resetServiceContainer();
  });

  it('should keep services registered after disposeAll', async () => {
    // Register a service
    registerService(
      'test-service',
      () => new MockService(),
      { lazyInitialization: true }
    );

    // Initialize the service
    const service1 = await getService<MockService>('test-service');
    expect(service1).toBeInstanceOf(MockService);
    expect(service1.initialized).toBe(true);
    expect(service1.disposed).toBe(false);

    // Dispose all services
    await disposeAllServices();

    // Service should be disposed
    expect(service1.disposed).toBe(true);

    // Service should still be registered (not cleared)
    const service2 = await getService<MockService>('test-service');
    expect(service2).toBeInstanceOf(MockService);
    
    // Should be a new instance (re-initialized)
    expect(service2).not.toBe(service1);
    expect(service2.initialized).toBe(true);
    expect(service2.disposed).toBe(false);
  });

  it('should clear registrations after reset', async () => {
    // Register a service
    registerService(
      'test-service-2',
      () => new MockService(),
      { lazyInitialization: true }
    );

    // Initialize the service
    const service1 = await getService<MockService>('test-service-2');
    expect(service1).toBeInstanceOf(MockService);

    // Reset the container
    await resetServiceContainer();

    // Service should NOT be registered anymore
    await expect(() => getService('test-service-2')).rejects.toThrow(
      "Service 'test-service-2' is not registered"
    );

    // tryGetService should return null
    const service2 = tryGetService<MockService>('test-service-2');
    expect(service2).toBeNull();
  });

  it('should handle multiple dispose cycles', async () => {
    // Register a service
    registerService(
      'test-service-3',
      () => new MockService(),
      { lazyInitialization: true }
    );

    // First lifecycle: initialize and dispose
    const service1 = await getService<MockService>('test-service-3');
    expect(service1.initialized).toBe(true);
    await disposeAllServices();
    expect(service1.disposed).toBe(true);

    // Second lifecycle: re-initialize and dispose again
    const service2 = await getService<MockService>('test-service-3');
    expect(service2).not.toBe(service1);
    expect(service2.initialized).toBe(true);
    expect(service2.disposed).toBe(false);
    await disposeAllServices();
    expect(service2.disposed).toBe(true);

    // Third lifecycle: should still work
    const service3 = await getService<MockService>('test-service-3');
    expect(service3).not.toBe(service2);
    expect(service3.initialized).toBe(true);
    expect(service3.disposed).toBe(false);
  });

  it('should handle concurrent access during disposal', async () => {
    // Register a service
    registerService(
      'test-service-4',
      () => new MockService(),
      { lazyInitialization: true }
    );

    // Initialize the service
    const service1 = await getService<MockService>('test-service-4');
    
    // Start disposal and concurrent access
    const disposePromise = disposeAllServices();
    
    // Try to get the service while disposal is in progress
    // This should either throw or wait for disposal to complete
    try {
      await getService<MockService>('test-service-4');
    } catch {
      // Expected — may throw during disposal
    }
    
    // Wait for disposal to complete
    await disposePromise;
    
    // Service should be disposed
    expect(service1.disposed).toBe(true);
    
    // Now we should be able to get a new instance
    const service2 = await getService<MockService>('test-service-4');
    expect(service2).not.toBe(service1);
    expect(service2.initialized).toBe(true);
  });
});

describe('Service Registry Integration Test', () => {
  afterEach(async () => {
    await resetServiceContainer();
  });

  it('should simulate typical test lifecycle', async () => {
    // Simulate test setup (register services)
    registerService('scheduler', () => new MockService(), { lazyInitialization: true });
    registerService('state-manager', () => new MockService(), { lazyInitialization: true });

    // Simulate beforeAll: initialize services
    const scheduler1 = await getService<MockService>('scheduler');
    const stateManager1 = await getService<MockService>('state-manager');
    expect(scheduler1.initialized).toBe(true);
    expect(stateManager1.initialized).toBe(true);

    // Simulate test execution
    expect(scheduler1.name).toBe('mock-service');
    expect(stateManager1.name).toBe('mock-service');

    // Simulate beforeEach: clean up (but keep registrations)
    await disposeAllServices();
    expect(scheduler1.disposed).toBe(true);
    expect(stateManager1.disposed).toBe(true);

    // Simulate next test: services should still be accessible
    const scheduler2 = await getService<MockService>('scheduler');
    const stateManager2 = await getService<MockService>('state-manager');
    expect(scheduler2).not.toBe(scheduler1);
    expect(stateManager2).not.toBe(stateManager1);
    expect(scheduler2.initialized).toBe(true);
    expect(stateManager2.initialized).toBe(true);

    // Simulate afterAll: full cleanup
    await resetServiceContainer();
    
    // Services should no longer be registered
    expect(tryGetService<MockService>('scheduler')).toBeNull();
    expect(tryGetService<MockService>('state-manager')).toBeNull();
  });
});