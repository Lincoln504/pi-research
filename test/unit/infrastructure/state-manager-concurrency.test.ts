import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { StateManager } from '../../../src/infrastructure/state-manager.ts';

describe('StateManager Concurrency and Lock Resilience', () => {
  const testDir = path.join(os.tmpdir(), `pi-concurrency-test-${Date.now()}`);
  let manager: StateManager;

  beforeEach(async () => {
    await fs.mkdir(testDir, { recursive: true });
    manager = new StateManager(testDir);
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('should handle high contention without losing updates', async () => {
    // Start 20 concurrent updates to a counter in state
    const iterations = 20;
    const promises = [];

    // Initialize state
    await manager.updateState(state => {
        (state as any).counter = 0;
        return state;
    });

    for (let i = 0; i < iterations; i++) {
        promises.push(manager.updateState(async (state) => {
            // Add a small random delay to increase chance of collisions
            await new Promise(r => setTimeout(r, Math.random() * 50));
            (state as any).counter = ((state as any).counter || 0) + 1;
            return state;
        }));
    }

    await Promise.all(promises);

    const finalState = await manager.readState();
    expect((finalState as any).counter).toBe(iterations);
  });

  it('should recover from a stale lock', async () => {
    const lockFilePath = manager.getLockFilePath();
    await fs.mkdir(path.dirname(lockFilePath), { recursive: true });
    
    // Manually create a stale lock (older than 30s)
    const staleTime = Date.now() - 40000;
    await fs.writeFile(lockFilePath, 'stale');
    await fs.utimes(lockFilePath, staleTime / 1000, staleTime / 1000);

    const start = Date.now();
    await manager.updateState(state => {
        state.containerId = 'recovered';
        return state;
    });
    const duration = Date.now() - start;

    // Should recover immediately because the lock is stale
    // (Actual time should be < 500ms, not hitting the 10s timeout)
    expect(duration).toBeLessThan(1000);
    
    const state = await manager.readState();
    expect(state.containerId).toBe('recovered');
  });

  it('should wait for a live lock and eventually succeed', async () => {
    const lockFilePath = manager.getLockFilePath();
    await fs.mkdir(path.dirname(lockFilePath), { recursive: true });
    
    // Create a fresh lock
    await fs.writeFile(lockFilePath, 'fresh');
    
    // In a few hundred ms, remove the lock manually to simulate another process finishing
    setTimeout(async () => {
        await fs.unlink(lockFilePath).catch(() => {});
    }, 300);

    const start = Date.now();
    await manager.updateState(state => {
        state.containerId = 'waited';
        return state;
    });
    const duration = Date.now() - start;

    expect(duration).toBeGreaterThanOrEqual(300);
    expect(duration).toBeLessThan(2000);
    
    const state = await manager.readState();
    expect(state.containerId).toBe('waited');
  });

  it('should throw if lock cannot be acquired within timeout', async () => {
    const lockFilePath = manager.getLockFilePath();
    await fs.mkdir(path.dirname(lockFilePath), { recursive: true });
    
    // Create a fresh lock that never goes away
    await fs.writeFile(lockFilePath, 'eternal');
    
    // Mock sleep to be fast so we don't actually wait 10s in the test
    (manager as any).lockRetryDelay = 1;
    (manager as any).lockRetries = 10;
    (manager as any).lockTimeout = 50;

    await expect(manager.updateState(s => s))
        .rejects.toThrow('Failed to acquire lock');
  });
});
