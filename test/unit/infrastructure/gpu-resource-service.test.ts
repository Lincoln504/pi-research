import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GPUResourceService } from '../../../src/infrastructure/gpu-resource-service.ts';
import type { SingletonState } from '../../../src/infrastructure/types/state-types.ts';
import { ServiceLifecycle } from '../../../src/core/service-registry.ts';

describe('GPUResourceService', () => {
  let service: GPUResourceService;
  let mockProcessLifecycle: any;
  let state: SingletonState;

  beforeEach(() => {
    mockProcessLifecycle = {
      getCurrentPid: vi.fn().mockReturnValue(123),
      getCurrentProcessStartTime: vi.fn().mockResolvedValue(1000),
      isProcessAlive: vi.fn().mockResolvedValue(true),
    };

    service = new GPUResourceService({
      processLifecycle: mockProcessLifecycle,
      gpuLockStaleThresholdMs: 1000, // Short threshold for testing
    });

    state = {
      initialized: true,
      lastCleanup: Date.now(),
    } as any;
  });

  async function updateState(updater: (state: SingletonState) => SingletonState | Promise<SingletonState>) {
    state = await updater(state);
  }

  it('should acquire GPU lock when no one owns it', async () => {
    const success = await service.acquireGpuLock(updateState, 'session-1');
    
    expect(success).toBe(true);
    expect(state.gpuOwner).toBeDefined();
    expect(state.gpuOwner?.pid).toBe(123);
    expect(state.gpuOwner?.sessionId).toBe('session-1');
  });

  it('should allow re-entrant lock acquisition by the same PID', async () => {
    state.gpuOwner = {
      pid: 123,
      startTime: 1000,
      startedAt: Date.now() - 500,
      sessionId: 'session-1',
    };

    const success = await service.acquireGpuLock(updateState, 'session-1-updated');
    
    expect(success).toBe(true);
    expect(state.gpuOwner?.sessionId).toBe('session-1-updated');
    expect(state.gpuOwner?.startedAt).toBeGreaterThan(Date.now() - 100);
  });

  it('should fail to acquire lock if held by another live process', async () => {
    state.gpuOwner = {
      pid: 456,
      startTime: 2000,
      startedAt: Date.now(),
      sessionId: 'other-session',
    };
    mockProcessLifecycle.isProcessAlive.mockResolvedValue(true);

    // Use short timeout to avoid long test
    const success = await service.acquireGpuLock(updateState, 'my-session', 100);
    
    expect(success).toBe(false);
    expect(state.gpuOwner?.pid).toBe(456);
  });

  it('should reclaim lock if owner is dead', async () => {
    state.gpuOwner = {
      pid: 456,
      startTime: 2000,
      startedAt: Date.now(),
      sessionId: 'dead-process-session',
    };
    mockProcessLifecycle.isProcessAlive.mockResolvedValue(false);

    const success = await service.acquireGpuLock(updateState, 'my-session');
    
    expect(success).toBe(true);
    expect(state.gpuOwner?.pid).toBe(123);
  });

  it('should reclaim lock if it is stale', async () => {
    state.gpuOwner = {
      pid: 456,
      startTime: 2000,
      startedAt: Date.now() - 2000, // Threshold is 1000
      sessionId: 'stale-session',
    };
    mockProcessLifecycle.isProcessAlive.mockResolvedValue(true);

    const success = await service.acquireGpuLock(updateState, 'my-session');
    
    expect(success).toBe(true);
    expect(state.gpuOwner?.pid).toBe(123);
  });

  it('should release lock if owned by the given PID', async () => {
    state.gpuOwner = {
      pid: 123,
      startTime: 1000,
      startedAt: Date.now(),
    };

    await service.releaseGpuLock(updateState, 123);
    
    expect(state.gpuOwner).toBeUndefined();
  });

  it('should NOT release lock if owned by another PID', async () => {
    state.gpuOwner = {
      pid: 456,
      startTime: 2000,
      startedAt: Date.now(),
    };

    await service.releaseGpuLock(updateState, 123);
    
    expect(state.gpuOwner).toBeDefined();
    expect(state.gpuOwner?.pid).toBe(456);
  });

  it('isGpuLockStale should return true if lock is older than threshold', async () => {
    state.gpuOwner = {
      pid: 456,
      startTime: 2000,
      startedAt: Date.now() - 5000,
    };

    const isStale = await service.isGpuLockStale(async () => state);
    expect(isStale).toBe(true);
  });

  it('doesCurrentProcessHoldGpuLock should return true if current PID matches', async () => {
    state.gpuOwner = {
      pid: 123,
      startTime: 1000,
      startedAt: Date.now(),
    };

    const holds = await service.doesCurrentProcessHoldGpuLock(async () => state);
    expect(holds).toBe(true);
  });
});
