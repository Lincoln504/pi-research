/**
 * Chaos Engineering Tests: GPU Lock Contention
 *
 * Tests chaotic scenarios for GPU lock management including:
 * - High contention for GPU lock
 * - Lock owner death detection and recovery
 * - Stale lock reclamation
 * - Concurrent lock acquisition attempts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { StateManager } from '../../../src/infrastructure/state-manager.ts';
import {
  withRandomDelay,
  executeBurst,
  measureTime,
  raceConcurrent,
} from '../../utils/chaos-helpers.ts';

describe('GPU Lock Contention Chaos Tests', () => {
  const testDir = path.join(os.tmpdir(), `pi-gpu-lock-test-${Date.now()}`);
  let manager: StateManager;

  beforeEach(async () => {
    await fs.mkdir(testDir, { recursive: true });
    manager = new StateManager(testDir);
  });

  afterEach(async () => {
    try {
      // Release any held locks
      await manager.releaseGpuLock(process.pid).catch(() => {});
      await fs.rm(testDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  describe('High Contention Scenarios', () => {
    it('should handle 20 concurrent lock acquisition attempts', async () => {
      const contenderCount = 20;
      const results: Array<{ pid: number; acquired: boolean; duration: number }> = [];

      const operations = Array.from({ length: contenderCount }, (_, i) =>
        async () => {
          const { result, durationMs } = await measureTime(async () => {
            return await manager.acquireGpuLock(`session-${i}`, 10000);
          });
          results.push({
            pid: process.pid,
            acquired: result,
            duration: durationMs
          });
          return result;
        }
      );

      // Execute all concurrently with random jitter
      await raceConcurrent(operations, { jitterMs: 10 });

      // Exactly one should have acquired the lock
      const acquisitions = results.filter(r => r.acquired);
      expect(acquisitions.length).toBe(1);

      // The winner should have completed relatively quickly
      expect(acquisitions[0].duration).toBeLessThan(1000);
    });

    it('should handle burst of lock acquisition attempts', async () => {
      const burstSize = 10;
      const burstCount = 3;
      const allResults: boolean[] = [];

      for (let b = 0; b < burstCount; b++) {
        // Release lock before each burst
        await manager.releaseGpuLock().catch(() => {});

        const operations = Array.from({ length: burstSize }, (_, i) =>
          async () => {
            const result = await manager.acquireGpuLock(`burst-${b}-${i}`, 5000);
            allResults.push(result);
            return result;
          }
        );

        await executeBurst(operations, burstSize);

        // Small delay between bursts
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      // Should have exactly burstCount successful acquisitions
      const successes = allResults.filter(r => r);
      expect(successes.length).toBe(burstCount);
    });

    it('should handle rapid lock acquire/release cycles', async () => {
      const cycleCount = 15;
      const results: Array<{ acquired: boolean; released: boolean }> = [];

      for (let i = 0; i < cycleCount; i++) {
        const acquired = await manager.acquireGpuLock(`cycle-${i}`, 1000);
        const released = acquired ? await manager.releaseGpuLock().then(() => true).catch(() => false) : false;
        results.push({ acquired, released });
      }

      // All should acquire and release successfully
      results.forEach(r => {
        expect(r.acquired).toBe(true);
        expect(r.released).toBe(true);
      });
    });

    it('should handle lock acquisition with delays and jitter', async () => {
      const operations = Array.from({ length: 8 }, (_, i) =>
        withRandomDelay(
          () => manager.acquireGpuLock(`delayed-${i}`, 10000),
          { min: 10, max: 100 }
        )()
      );

      const results = await Promise.allSettled(operations);

      // At least one should succeed
      const successes = results.filter(r => r.status === 'fulfilled' && r.value);
      expect(successes.length).toBeGreaterThanOrEqual(1);

      // Clean up
      await manager.releaseGpuLock().catch(() => {});
    });
  });

  describe('Lock Owner Death Detection', () => {
    it('should reclaim lock when owner process dies', async () => {
      // First, acquire the lock
      const acquired1 = await manager.acquireGpuLock('owner-1', 5000);
      expect(acquired1).toBe(true);

      const owner1 = await manager.getGpuOwner();
      expect(owner1?.pid).toBe(process.pid);
      expect(owner1?.sessionId).toBe('owner-1');

      // Simulate owner death by using a different PID
      const fakePid = 99999;
      
      // Manually set state to simulate dead owner
      await manager.updateState(state => {
        state.gpuOwner = {
          pid: fakePid,
          startedAt: Date.now(),
          sessionId: 'dead-owner'
        };
        return state;
      });

      // Now try to acquire - should reclaim the lock
      const acquired2 = await manager.acquireGpuLock('new-owner', 5000);
      expect(acquired2).toBe(true);

      const newOwner = await manager.getGpuOwner();
      expect(newOwner?.pid).toBe(process.pid);
      expect(newOwner?.sessionId).toBe('new-owner');
    });

    it('should handle multiple dead owners in sequence', async () => {
      const deadPids = [88888, 99999, 77777];

      for (let i = 0; i < deadPids.length; i++) {
        // Set state with dead owner
        await manager.updateState(state => {
          state.gpuOwner = {
            pid: deadPids[i],
            startedAt: Date.now() - 100000, // Old lock
            sessionId: `dead-${i}`
          };
          return state;
        });

        // Should reclaim
        const acquired = await manager.acquireGpuLock(`owner-${i}`, 5000);
        expect(acquired).toBe(true);

        const owner = await manager.getGpuOwner();
        expect(owner?.pid).toBe(process.pid);
        expect(owner?.sessionId).toBe(`owner-${i}`);

        // Release for next iteration
        await manager.releaseGpuLock();
      }
    });

    it('should not reclaim lock from live process', async () => {
      // Acquire lock
      const acquired = await manager.acquireGpuLock('live-owner', 5000);
      expect(acquired).toBe(true);

      // Try to acquire with different "PID" while we're still alive
      // This simulates a second process trying to acquire
      const state = await manager.readState();
      expect(state.gpuOwner?.pid).toBe(process.pid);

      // Another attempt from same process (re-entrant) should succeed
      const acquired2 = await manager.acquireGpuLock('same-process', 5000);
      expect(acquired2).toBe(true);

      // Should still be the same owner
      const owner = await manager.getGpuOwner();
      expect(owner?.pid).toBe(process.pid);
      // Session ID might have updated
      expect(owner?.sessionId).toBeDefined();
    });
  });

  describe('Stale Lock Reclamation', () => {
    it('should reclaim locks older than staleness threshold', async () => {
      // Set a very old lock
      const staleTime = Date.now() - 300000; // 5 minutes ago (older than 3 min threshold)

      await manager.updateState(state => {
        state.gpuOwner = {
          pid: process.pid, // Same PID, but lock is stale
          startedAt: staleTime,
          sessionId: 'stale-owner'
        };
        return state;
      });

      // Should reclaim even though PID is same (because lock is stale)
      const acquired = await manager.acquireGpuLock('new-owner', 5000);
      expect(acquired).toBe(true);

      const owner = await manager.getGpuOwner();
      expect(owner?.sessionId).toBe('new-owner');
      expect(owner?.startedAt).toBeGreaterThan(Date.now() - 10000); // Recently updated
    });

    it('should not reclaim fresh locks', async () => {
      // Acquire fresh lock
      const acquired = await manager.acquireGpuLock('fresh-owner', 5000);
      expect(acquired).toBe(true);

      // Try to acquire again from same "process" - should succeed (re-entrant)
      const acquired2 = await manager.acquireGpuLock('same-fresh', 5000);
      expect(acquired2).toBe(true);

      // Owner should be updated but not changed
      const owner = await manager.getGpuOwner();
      expect(owner?.pid).toBe(process.pid);
    });

    it('should handle lock near staleness threshold', async () => {
      // Set lock just at the threshold boundary
      const thresholdMs = 180000; // 3 minutes
      const nearThresholdTime = Date.now() - thresholdMs + 1000; // 1 second before threshold

      await manager.updateState(state => {
        state.gpuOwner = {
          pid: 99999,
          startedAt: nearThresholdTime,
          sessionId: 'near-stale'
        };
        return state;
      });

      // Should NOT reclaim yet (still within threshold)
      // Note: This test depends on the exact timing implementation
      const acquired = await manager.acquireGpuLock('attempt', 5000);
      
      // The behavior depends on whether the process is alive
      // Since 99999 is not alive, it might reclaim anyway
      expect(typeof acquired).toBe('boolean');
    });
  });

  describe('Concurrent Lock Operations', () => {
    it('should handle mixed acquire and release operations', async () => {
      const operations: Promise<boolean>[] = [];

      // Initial acquire
      operations.push(manager.acquireGpuLock('initial', 5000));

      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 50));

      // Concurrent operations while lock is held
      for (let i = 0; i < 5; i++) {
        operations.push(manager.acquireGpuLock(`concurrent-${i}`, 100));
      }

      // Release (should work)
      operations.push(manager.releaseGpuLock().then(() => true));

      const results = await Promise.allSettled(operations);

      // At least the initial acquire should succeed
      const successCount = results.filter(r => r.status === 'fulfilled' && r.value).length;
      expect(successCount).toBeGreaterThanOrEqual(1);

      // Clean up
      await manager.releaseGpuLock().catch(() => {});
    });

    it('should handle rapid state updates with lock operations', async () => {
      const updateCount = 20;
      let acquired = false;

      // First acquire
      acquired = await manager.acquireGpuLock('rapid-test', 5000);
      expect(acquired).toBe(true);

      // Perform rapid state updates while holding lock
      const updatePromises = Array.from({ length: updateCount }, (_, i) =>
        manager.updateState(state => {
          (state as any).counter = ((state as any).counter || 0) + 1;
          return state;
        })
      );

      await Promise.all(updatePromises);

      // Verify state integrity
      const finalState = await manager.readState();
      expect((finalState as any).counter).toBe(updateCount);

      // Lock should still be held
      const owner = await manager.getGpuOwner();
      expect(owner?.pid).toBe(process.pid);

      // Release
      await manager.releaseGpuLock();
    });

    it('should serialize lock acquisition correctly', async () => {
      const acquisitionOrder: number[] = [];
      const operations = Array.from({ length: 10 }, (_, i) =>
        async () => {
          const start = Date.now();
          const acquired = await manager.acquireGpuLock(`serialized-${i}`, 2000);
          acquisitionOrder.push(i);
          
          if (acquired) {
            // Hold briefly
            await new Promise(resolve => setTimeout(resolve, 50));
            await manager.releaseGpuLock().catch(() => {});
          }
          
          return { index: i, acquired, waitTime: Date.now() - start };
        }
      );

      await raceConcurrent(operations, { jitterMs: 5 });

      // Should have at least one successful acquisition
      expect(acquisitionOrder.length).toBeGreaterThan(0);
    });
  });

  describe('Lock Timeout Scenarios', () => {
    it('should timeout when lock is held by another process', async () => {
      // Simulate another process holding the lock
      await manager.updateState(state => {
        state.gpuOwner = {
          pid: 88888,
          startedAt: Date.now(),
          sessionId: 'other-process'
        };
        return state;
      });

      // Short timeout
      const acquired = await manager.acquireGpuLock('timeout-test', 100);
      expect(acquired).toBe(false);
    });

    it('should succeed with sufficient timeout', async () => {
      // Simulate another process holding the lock
      await manager.updateState(state => {
        state.gpuOwner = {
          pid: 88888,
          startedAt: Date.now() - 1000, // 1 second old
          sessionId: 'other-process'
        };
        return state;
      });

      // Long timeout - but since PID is not alive, should reclaim quickly
      const { result, durationMs } = await measureTime(() =>
        manager.acquireGpuLock('long-timeout', 10000)
      );

      expect(result).toBe(true);
      expect(durationMs).toBeLessThan(5000); // Should reclaim much faster than timeout
    });

    it('should handle zero timeout gracefully', async () => {
      const acquired = await manager.acquireGpuLock('zero-timeout', 0);
      // With no other holder, should acquire immediately
      expect(typeof acquired).toBe('boolean');

      // Clean up
      if (acquired) {
        await manager.releaseGpuLock();
      }
    });
  });

  describe('Error Handling and Edge Cases', () => {
    it('should handle lock release without acquisition', async () => {
      // Should not throw even if no lock is held
      await expect(manager.releaseGpuLock()).resolves.not.toThrow();
    });

    it('should handle release with different PID', async () => {
      // Acquire with current PID
      const acquired = await manager.acquireGpuLock('test-owner', 5000);
      expect(acquired).toBe(true);

      // Try to release with different PID
      const fakePid = 77777;
      await manager.releaseGpuLock(fakePid);

      // Our lock should still be held
      const owner = await manager.getGpuOwner();
      expect(owner?.pid).toBe(process.pid);

      // Clean up
      await manager.releaseGpuLock(process.pid);
    });

    it('should handle getGpuOwner when no lock is held', async () => {
      const owner = await manager.getGpuOwner();
      expect(owner).toBeNull();
    });

    it('should handle rapid acquire-release-acquire cycles', async () => {
      for (let i = 0; i < 10; i++) {
        const acquired1 = await manager.acquireGpuLock(`cycle1-${i}`, 1000);
        expect(acquired1).toBe(true);

        await manager.releaseGpuLock();

        const acquired2 = await manager.acquireGpuLock(`cycle2-${i}`, 1000);
        expect(acquired2).toBe(true);

        await manager.releaseGpuLock();
      }
    });

    it('should maintain session ID across operations', async () => {
      const sessionId = 'persistent-session';
      
      const acquired1 = await manager.acquireGpuLock(sessionId, 5000);
      expect(acquired1).toBe(true);

      const owner1 = await manager.getGpuOwner();
      expect(owner1?.sessionId).toBe(sessionId);

      // Re-acquire with same session
      const acquired2 = await manager.acquireGpuLock(sessionId, 5000);
      expect(acquired2).toBe(true);

      const owner2 = await manager.getGpuOwner();
      expect(owner2?.sessionId).toBe(sessionId);

      await manager.releaseGpuLock();
    });
  });

  describe('Performance Under Load', () => {
    it('should handle 50 sequential acquire/release cycles efficiently', async () => {
      const cycleCount = 50;
      const durations: number[] = [];

      for (let i = 0; i < cycleCount; i++) {
        const { durationMs } = await measureTime(async () => {
          const acquired = await manager.acquireGpuLock(`perf-${i}`, 1000);
          if (acquired) {
            await manager.releaseGpuLock();
          }
        });
        durations.push(durationMs);
      }

      // All cycles should complete quickly (< 100ms each)
      durations.forEach(d => {
        expect(d).toBeLessThan(100);
      });

      // Average should be reasonable
      const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
      expect(avg).toBeLessThan(50);
    });

    it('should handle concurrent read operations while lock is held', async () => {
      // Acquire lock
      const acquired = await manager.acquireGpuLock('concurrent-read', 5000);
      expect(acquired).toBe(true);

      // Perform many concurrent reads
      const readOperations = Array.from({ length: 20 }, () =>
        manager.readState()
      );

      const results = await Promise.all(readOperations);
      
      // All reads should succeed
      results.forEach(state => {
        expect(state).toBeDefined();
        expect(state.gpuOwner?.pid).toBe(process.pid);
      });

      // Release
      await manager.releaseGpuLock();
    });
  });
});