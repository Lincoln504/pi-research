/**
 * Shutdown Integration Tests
 *
 * Tests graceful shutdown behavior including embedder disposal and browser pool cleanup.
 */

import { describe, it, expect, vi } from 'vitest';

describe('Graceful shutdown', () => {
  it('should run cleanup tasks in reverse order', async () => {
    // Import ShutdownManager class to test order
    const { ShutdownManager } = await import('../../src/utils/shutdown-manager.ts');
    
    const manager = new ShutdownManager();
    const calls: string[] = [];

    // Register tasks in order
    manager.register(() => { calls.push('first'); });
    manager.register(() => { calls.push('second'); });
    manager.register(() => { calls.push('third'); });

    // Run cleanup - should execute in reverse order
    await manager.runCleanup('test-order');

    expect(calls).toEqual(['third', 'second', 'first']);
  });

  it('should continue cleanup when a task throws', async () => {
    const { ShutdownManager } = await import('../../src/utils/shutdown-manager.ts');
    
    const manager = new ShutdownManager();
    const calls: string[] = [];

    manager.register(() => { calls.push('first'); });
    manager.register(() => {
      throw new Error('cleanup failed');
    });
    manager.register(() => { calls.push('third'); });

    // Should not throw and should execute all non-failing tasks
    await expect(manager.runCleanup('test-error')).resolves.not.toThrow();
    expect(calls).toEqual(['third', 'first']);
  });

  it('should be idempotent and support multiple cleanup cycles', async () => {
    const { ShutdownManager } = await import('../../src/utils/shutdown-manager.ts');
    
    const manager = new ShutdownManager();
    const task1 = vi.fn();
    const task2 = vi.fn();

    // Register tasks
    manager.register(task1);
    manager.register(task2);

    // Run first cleanup
    await manager.runCleanup('first');
    expect(task1).toHaveBeenCalledTimes(1);
    expect(task2).toHaveBeenCalledTimes(1);

    // Run second cleanup with same tasks (should be no-op due to idempotency)
    await manager.runCleanup('second');
    expect(task1).toHaveBeenCalledTimes(1);
    expect(task2).toHaveBeenCalledTimes(1);

    // Register new task and run third cleanup
    const task3 = vi.fn();
    manager.register(task3);
    await manager.runCleanup('third');
    expect(task3).toHaveBeenCalledTimes(1);
  });
});
