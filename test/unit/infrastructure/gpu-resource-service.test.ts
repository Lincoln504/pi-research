import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GPUResourceService } from '../../../src/infrastructure/gpu-resource-service.ts';
import { ServiceNames } from '../../../src/core/service-interfaces.ts';
import * as ServiceRegistry from '../../../src/core/service-registry.ts';
import type { SingletonState } from '../../../src/infrastructure/types/state-types.ts';

// Mock the service registry
vi.mock('../../../src/core/service-registry.ts', async () => {
  const actual = await vi.importActual('../../../src/core/service-registry.ts') as any;
  return {
    ...actual,
    getService: vi.fn(),
    tryGetServiceContainerFromCtx: vi.fn().mockReturnValue({}),
  };
});

describe('GPUResourceService', () => {
  let service: GPUResourceService;
  let mockProcessLifecycle: any;
  let state: SingletonState;

  beforeEach(() => {
    vi.clearAllMocks();

    mockProcessLifecycle = {
      getCurrentPid: vi.fn().mockReturnValue(123),
      getCurrentProcessStartTime: vi.fn().mockResolvedValue(1000),
      isProcessAlive: vi.fn().mockResolvedValue(true),
    };

    service = new GPUResourceService({
      processLifecycle: mockProcessLifecycle,
      gpuLockStaleThresholdMs: 1000,
    });

    state = {
      version: 1,
      containerId: 'test-container',
      containerName: 'test',
      port: 0,
      sessions: {},
      lastUpdated: Date.now(),
    };
  });

  async function updateState(updater: (state: SingletonState) => SingletonState | Promise<SingletonState>) {
    state = await updater(state);
  }

  describe('Internal logic (called by StateManager)', () => {
    it('should acquire GPU lock when no one owns it', async () => {
      const success = await service.acquireGpuLock(updateState as any, 'session-1');
      
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

      const success = await service.acquireGpuLock(updateState as any, 'session-1-updated');
      
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

      const success = await service.acquireGpuLock(updateState as any, 'my-session', 100);
      
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

      const success = await service.acquireGpuLock(updateState as any, 'my-session');
      
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

      const success = await service.acquireGpuLock(updateState as any, 'my-session');
      
      expect(success).toBe(true);
      expect(state.gpuOwner?.pid).toBe(123);
    });

    it('should release lock if owned by the given PID', async () => {
      state.gpuOwner = {
        pid: 123,
        startTime: 1000,
        startedAt: Date.now(),
      };

      await service.releaseGpuLock(updateState as any, 123);

      expect(state.gpuOwner).toBeUndefined();
    });
  });

  describe('Re-entrant hold counting (concurrent in-process embeds)', () => {
    it('initializes holds to 1 on a fresh acquire', async () => {
      await service.acquireGpuLock(updateState as any, 'session-1');
      expect(state.gpuOwner?.holds).toBe(1);
    });

    it('increments holds on a re-entrant acquire by the same PID', async () => {
      await service.acquireGpuLock(updateState as any, 'session-1');
      await service.acquireGpuLock(updateState as any, 'session-1');
      expect(state.gpuOwner?.holds).toBe(2);
    });

    it('keeps the lock held until the last in-process release', async () => {
      // Two concurrent in-process holds.
      await service.acquireGpuLock(updateState as any, 'session-1');
      await service.acquireGpuLock(updateState as any, 'session-1');
      expect(state.gpuOwner?.holds).toBe(2);

      // First sibling finishes — lock must remain held for the second.
      await service.releaseGpuLock(updateState as any);
      expect(state.gpuOwner).toBeDefined();
      expect(state.gpuOwner?.holds).toBe(1);

      // Last sibling finishes — now the cross-process record is cleared.
      await service.releaseGpuLock(updateState as any);
      expect(state.gpuOwner).toBeUndefined();
    });

    it('treats a hold-less legacy owner record as a single hold', async () => {
      // State written before refcounting has no holds field.
      state.gpuOwner = { pid: 123, startTime: 1000, startedAt: Date.now(), sessionId: 'legacy' };
      await service.releaseGpuLock(updateState as any);
      expect(state.gpuOwner).toBeUndefined();
    });

    it('forces a full release when an explicit foreign pid is given', async () => {
      // Owner has multiple in-process holds, but a forced takedown of that pid
      // (e.g. reclaiming a dead owner) clears the record regardless of count.
      state.gpuOwner = { pid: 123, startTime: 1000, startedAt: Date.now(), holds: 3 };
      await service.releaseGpuLock(updateState as any, 123);
      expect(state.gpuOwner).toBeUndefined();
    });
  });

  describe('Service interface (delegation)', () => {
    it('should delegate acquireGpuLock to StateManager', async () => {
      const mockStateManager = {
        acquireGpuLock: vi.fn().mockResolvedValue(true),
      };
      vi.mocked(ServiceRegistry.getService).mockImplementation(async (name) => {
        if (name === ServiceNames.STATE_MANAGER) return mockStateManager;
        return { name: 'stub', lifecycle: 0 } as any;
      });

      const success = await service.acquireGpuLock('session-1', 1000);
      
      expect(success).toBe(true);
      expect(mockStateManager.acquireGpuLock).toHaveBeenCalledWith('session-1', 1000);
    });
  });
});
