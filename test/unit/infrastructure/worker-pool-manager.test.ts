/**
 * WorkerPoolManager unit tests
 *
 * Focused on the lifecycle correctness that caused the integration test suites
 * to be describe.skip'd:
 *
 *   Root cause: isShuttingDown was never reset after shutdown() completed.
 *   The service registry keeps the same WorkerPoolManager instance across
 *   scheduler restarts, so ensurePool() would permanently throw "Worker pool
 *   is shutting down" after the first stopBrowserManager() call.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module-level mocks (must be declared before WorkerPoolManager is imported)
// ---------------------------------------------------------------------------

vi.mock('../../../src/logger.ts', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));

vi.mock('../../../src/utils/metrics.ts', () => ({
  metrics: { increment: vi.fn(), setGauge: vi.fn(), observe: vi.fn() },
}));

vi.mock('../../../src/config.ts', () => ({
  getConfig: vi.fn(() => ({ WORKER_CONCURRENCY: 1 })),
}));

// Consolidated mock for browser/config.ts (merged from browser-config.ts + browser-configuration.ts)
vi.mock('../../../src/infrastructure/browser/config.ts', () => ({
  ensureBrowserCacheDir: vi.fn(),
  getBrowserEnv: vi.fn(() => ({})),
  getBrowserCacheDir: vi.fn(() => '/tmp/test-browser-cache'),
  getBrowserProfileDir: vi.fn(() => '/tmp/test-browser-profiles'),
  getCamoufoxBinaryPath: vi.fn(() => '/tmp/test-browser-cache/camoufox'),
  getMaxWorkers: vi.fn(() => 2),
  generateSchedulerVersion: vi.fn(() => 'v1'),
  getSchedulerVersion: vi.fn(() => 'v1'),
  isBrowserAvailable: vi.fn(() => true),
}));

// Profile cleanup is fire-and-forget at pool init; stub it so the test never
// touches the real filesystem.
vi.mock('../../../src/infrastructure/browser/cleanup-utils.ts', () => ({
  cleanupStaleProfiles: vi.fn(async () => ({ removed: 0, errors: 0 })),
}));

// Browser provisioning + orphan sweep run inside ensurePool(); stub them so the
// init path is deterministic and offline. ensureBrowserInstalled is also the
// hook the resurrection test uses to hold the init mid-flight.
vi.mock('../../../src/infrastructure/browser/ensure-browser.ts', () => ({
  ensureBrowserInstalled: vi.fn(async () => {}),
}));
vi.mock('../../../src/infrastructure/browser/browser-cleanup.ts', () => ({
  cleanupOrphanedCamoufoxProcesses: vi.fn(async () => {}),
}));

// existsSync(workerPath) must be truthy so ensurePool() doesn't fail on the
// missing-worker-bundle guard.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn(() => true) };
});

// ---------------------------------------------------------------------------
// Minimal FixedClusterPool stub — must use a regular function (not arrow) so
// that vitest allows `new FixedClusterPool(...)` to work.
// ---------------------------------------------------------------------------

const poolRegistry = vi.hoisted(() => ({ instances: [] as any[] }));

vi.mock('poolifier', () => {

  function FixedClusterPool(this: any, _size: number, _path: string, _opts?: unknown) {
    this.execute = vi.fn().mockResolvedValue({});
    this.destroy = vi.fn().mockResolvedValue(undefined);
    poolRegistry.instances.push(this);
    return this;
  }

  return {
    FixedClusterPool,
    WorkerChoiceStrategies: { ROUND_ROBIN: 'ROUND_ROBIN' },
  };
});

// ---------------------------------------------------------------------------
// Import under test (after mocks are registered)
// ---------------------------------------------------------------------------

import { WorkerPoolManager } from '../../../src/infrastructure/browser/worker-pool-manager.ts';
import { ensureBrowserInstalled } from '../../../src/infrastructure/browser/ensure-browser.ts';

const tick = () => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkerPoolManager', () => {
  let manager: WorkerPoolManager;

  beforeEach(() => {
    vi.clearAllMocks();
    poolRegistry.instances.length = 0;
    manager = new WorkerPoolManager();
  });

  describe('isShuttingDown reset — the core regression guard', () => {
    it('resets isShuttingDown to false after shutdown() completes', async () => {
      // Create a pool first so there is something to destroy
      await manager.ensurePool();
      expect(manager.getPool()).not.toBeNull();

      // Shutdown should complete without keeping isShuttingDown = true
      await manager.shutdown();

      // After shutdown the pool reference is cleared
      expect(manager.getPool()).toBeNull();
      expect(manager.isPoolShuttingDown()).toBe(false);   // THE FIX
    });

    it('allows ensurePool() to succeed after a completed shutdown', async () => {
      await manager.ensurePool();
      await manager.shutdown();

      // Without the fix this would throw "Worker pool is shutting down"
      await expect(manager.ensurePool()).resolves.not.toBeNull();
    });

    it('allows multiple stop/start cycles on the same instance', async () => {
      for (let i = 0; i < 3; i++) {
        await manager.ensurePool();
        expect(manager.getPool()).not.toBeNull();

        await manager.shutdown();
        expect(manager.getPool()).toBeNull();
        expect(manager.isPoolShuttingDown()).toBe(false);
      }
    });
  });

  describe('consecutive-error decay (slow crash-loop recovery)', () => {
    it('decays the counter by one without zeroing it, so slow failures still accumulate', () => {
      // White-box: the leadership tick used to blind-reset this to 0 every ~5s,
      // which defeated auto-recovery for any crash-loop slower than 3-errors-per-tick.
      (manager as any).consecutiveErrors = 2;
      manager.decayConsecutiveErrors();
      expect((manager as any).consecutiveErrors).toBe(1);
      manager.decayConsecutiveErrors();
      expect((manager as any).consecutiveErrors).toBe(0);
      // Never goes negative.
      manager.decayConsecutiveErrors();
      expect((manager as any).consecutiveErrors).toBe(0);
    });

    it('resetConsecutiveErrors() still zeroes outright (used by schedule/shutdown paths)', () => {
      (manager as any).consecutiveErrors = 5;
      manager.resetConsecutiveErrors();
      expect((manager as any).consecutiveErrors).toBe(0);
    });
  });

  describe('fast-fail during active shutdown', () => {
    it('throws "Worker pool is shutting down" if ensurePool() is called while shutdown is still in progress (no pool)', async () => {
      // Start with no pool so ensurePool() enters the creation path (not the
      // fast-return-existing-pool path).  Then simulate mid-shutdown state by
      // setting isShuttingDown = true on the bare instance.
      (manager as any).pool = null;
      (manager as any).currentWorkerCount = null;
      (manager as any).isShuttingDown = true;

      await expect(manager.ensurePool()).rejects.toThrow('Worker pool is shutting down');

      // Clean up so subsequent tests are not affected
      (manager as any).isShuttingDown = false;
    });

    it('throws "Worker pool is shutting down" even when a pool reference exists (pool mid-destroy)', async () => {
      // This is the key regression guard: before the fix, ensurePool() had an
      // early return that handed out the cached pool without checking isShuttingDown.
      // If pool.destroy() was in progress the caller would receive a pool in
      // "destroying" state and poolifier would throw
      // "Cannot execute a task on destroying pool".
      const fakePool = {} as any; // simulate a non-null pool reference
      (manager as any).pool = fakePool;
      (manager as any).currentWorkerCount = 1; // same as default maxWorkers mock
      (manager as any).isShuttingDown = true;

      // Should throw even though pool is non-null and worker count matches.
      await expect(manager.ensurePool()).rejects.toThrow('Worker pool is shutting down');

      // Clean up
      (manager as any).pool = null;
      (manager as any).currentWorkerCount = null;
      (manager as any).isShuttingDown = false;
    });
  });

  describe('concurrent initialization coalescing', () => {
    it('returns the same pool for concurrent ensurePool() calls', async () => {
      const [p1, p2, p3] = await Promise.all([
        manager.ensurePool(),
        manager.ensurePool(),
        manager.ensurePool(),
      ]);
      expect(p1).toBe(p2);
      expect(p2).toBe(p3);
    });
  });

  describe('shutdown during in-flight init (resurrection + leak guard)', () => {
    it('tears down a pool built by an init that was in flight when shutdown ran', async () => {
      // Hold the init mid-flight at ensureBrowserInstalled (before the pool is
      // constructed), exactly the window where shutdown() used to skip teardown
      // (this.pool still null) and then reset isShuttingDown=false, letting the
      // init finish and leak a fully-referenced pool.
      let releaseInit!: () => void;
      const initGate = new Promise<void>((resolve) => { releaseInit = resolve; });
      vi.mocked(ensureBrowserInstalled).mockImplementationOnce(async () => { await initGate; });

      const ensurePromise = manager.ensurePool();
      await tick(); // let ensurePool enter the IIFE and block on ensureBrowserInstalled

      // Shutdown while the init is parked. It bumps the generation and awaits the
      // in-flight init rather than returning early.
      const shutdownPromise = manager.shutdown();
      await tick();

      // Let the init proceed: it builds the pool, sees the generation changed,
      // destroys it, and throws.
      releaseInit();
      await shutdownPromise;
      await expect(ensurePromise).rejects.toThrow(/shutting down/);

      // Exactly one pool was constructed, and it was destroyed — not leaked.
      expect(poolRegistry.instances.length).toBe(1);
      expect(poolRegistry.instances[0].destroy).toHaveBeenCalled();
      expect(manager.getPool()).toBeNull();
      expect(manager.isPoolShuttingDown()).toBe(false);

      // The instance is still reusable afterwards.
      await expect(manager.ensurePool()).resolves.not.toBeNull();
    });
  });

  describe('idempotent shutdown', () => {
    it('second shutdown() call is a no-op', async () => {
      await manager.ensurePool();
      await manager.shutdown();
      // A second call should not throw
      await expect(manager.shutdown()).resolves.toBeUndefined();
    });
  });

  describe('dispose() delegates to shutdown()', () => {
    it('pool is null and isShuttingDown is false after dispose()', async () => {
      await manager.initialize();
      await manager.ensurePool();
      await manager.dispose();

      expect(manager.getPool()).toBeNull();
      expect(manager.isPoolShuttingDown()).toBe(false);
    });
  });
});
