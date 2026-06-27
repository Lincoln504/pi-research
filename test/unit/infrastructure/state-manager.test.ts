import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { StateManager } from '../../../src/infrastructure/state/state-manager.ts';
import { ProcessLifecycleService } from '../../../src/infrastructure/process-lifecycle-service.ts';
import { GPUResourceService } from '../../../src/infrastructure/gpu-resource-service.ts';
import { StateSessionManager } from '../../../src/infrastructure/state/state-session-manager.ts';
import { StateBrowserManager } from '../../../src/infrastructure/state/state-browser-manager.ts';
import { StateMetricsCollector } from '../../../src/infrastructure/state/state-metrics.ts';
import { StateValidator } from '../../../src/infrastructure/state/state-validator.ts';
import { FileLockService } from '../../../src/infrastructure/file-lock-service.ts';
import { StateBackupManager } from '../../../src/infrastructure/state/state-backup-manager.ts';

describe('StateManager Integration-style Tests', () => {
  // mkdtempSync atomically creates a unique, owner-only (0o700) dir — avoids the
  // predictable-name temp-file pattern CodeQL flags.
  const testDir = mkdtempSync(path.join(os.tmpdir(), 'pi-test-state-'));
  let manager: StateManager;
  let processLifecycle: ProcessLifecycleService;
  let fileLockService: FileLockService;
  let backupManager: StateBackupManager;
  let gpuResourceService: GPUResourceService;
  let sessionManager: StateSessionManager;
  let browserManager: StateBrowserManager;
  let metricsCollector: StateMetricsCollector;
  let validator: StateValidator;

  beforeEach(async () => {
    // Ensure fresh test directory
    await fs.mkdir(testDir, { recursive: true });

    // Create a process lifecycle service for tests
    processLifecycle = new ProcessLifecycleService();
    await processLifecycle.initialize();

    // Create file lock service
    const lockDirPath = path.join(testDir, '.locks');
    await fs.mkdir(lockDirPath, { recursive: true });
    fileLockService = new FileLockService({
      lockFilePath: path.join(lockDirPath, 'research-state.lock'),
    });
    await fileLockService.initialize();

    // Create backup manager
    const backupDirPath = path.join(testDir, 'backups');
    await fs.mkdir(backupDirPath, { recursive: true });
    backupManager = new StateBackupManager(
      path.join(testDir, 'research-state.json'),
      backupDirPath,
      10 // maxBackups
    );
    await backupManager.initialize();

    // Create all required dependencies
    gpuResourceService = new GPUResourceService({ processLifecycle });
    await gpuResourceService.initialize();

    sessionManager = new StateSessionManager(processLifecycle);
    await sessionManager.initialize();

    browserManager = new StateBrowserManager();
    await browserManager.initialize();

    metricsCollector = new StateMetricsCollector();
    await metricsCollector.initialize();

    validator = new StateValidator();
    await validator.initialize();

    // Create state manager with all dependencies
    manager = new StateManager({
      stateDir: testDir,
      processLifecycle,
      fileLockService,
      backupManager,
      gpuResourceService,
      sessionManager,
      browserManager,
      metricsCollector,
      validator,
    });
  });

  afterEach(async () => {
    // Cleanup state manager
    try {
      await manager.cleanup();
    } catch { /* ignore cleanup errors */ }
    
    // Cleanup all services
    for (const service of [validator, metricsCollector, browserManager, sessionManager, gpuResourceService, processLifecycle]) {
      if (service) {
        try {
          await service.dispose();
        } catch { /* ignore */ }
      }
    }
    
    // Cleanup test directory
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch { /* ignore cleanup errors */ }
  });

  it('should initialize directories on read', async () => {
    await manager.readState();
    
    // Check if dirs were created
    const stats = await fs.stat(testDir);
    expect(stats.isDirectory()).toBe(true);
    
    const lockDir = path.join(testDir, '.locks');
    const lockStats = await fs.stat(lockDir);
    expect(lockStats.isDirectory()).toBe(true);
  });

  it('should write and read state correctly', async () => {
    const initialState = await manager.readState();
    expect(initialState.sessions).toEqual({});

    await manager.addSession('session-1', 'container-1');
    const state = await manager.readState();
    expect(state.sessions['session-1']).toBeDefined();
    expect(state.sessions['session-1']?.pid).toBe(process.pid);
  });

  it('should update heartbeat', async () => {
    const { vi } = await import('vitest');
    vi.useFakeTimers();
    
    await manager.addSession('session-1', 'container-1');
    const state1 = await manager.readState();
    const lastSeen1 = state1.sessions['session-1']?.lastSeen ?? 0;

    // Small delay to ensure timestamp changes
    vi.advanceTimersByTime(10);
    
    await manager.updateHeartbeat('session-1');
    const state2 = await manager.readState();
    const lastSeen2 = state2.sessions['session-1']?.lastSeen ?? 0;
    
    expect(lastSeen2).toBeGreaterThan(lastSeen1);
    vi.useRealTimers();
  });

  it('should remove session', async () => {
    await manager.addSession('session-1', 'container-1');
    await manager.removeSession('session-1');
    
    const state = await manager.readState();
    expect(state.sessions['session-1']).toBeUndefined();
  });

  it('should handle file locking', async () => {
    // Use real timers for this test since file locking uses actual async operations
    // that are compatible with real locks
    // Start a long-running update
    const p1 = manager.updateState(async (state) => {
      await new Promise(r => setTimeout(r, 100)); // Hold lock for 100ms
      state.containerId = 'busy';
      return state;
    });

    // Start another update immediately - it should wait for p1
    const p2 = manager.updateState((state) => {
      state.containerName = 'won';
      return state;
    });

    await Promise.all([p1, p2]);

    const finalState = await manager.readState();
    expect(finalState.containerId).toBe('busy');
    expect(finalState.containerName).toBe('won');
  });

  it('should recover from corrupted JSON', async () => {
    // Manually corrupt the file
    const stateFile = path.join(testDir, 'research-state.json');
    await fs.mkdir(path.dirname(stateFile), { recursive: true });
    await fs.writeFile(stateFile, '{ corrupted: json [ ] ', 'utf-8');

    // Should recover with default state without throwing
    const state = await manager.readState();
    expect(state.version).toBe(1);
    expect(state.sessions).toEqual({});
  });

  it('should recover from a schema-invalid (well-formed JSON) state file', async () => {
    // Valid JSON, but fails schema validation: out-of-range port + missing fields.
    // This must NOT brick every reader — recover to default rather than throwing.
    const stateFile = path.join(testDir, 'research-state.json');
    await fs.mkdir(path.dirname(stateFile), { recursive: true });
    await fs.writeFile(stateFile, JSON.stringify({ version: 1, port: 999999 }), 'utf-8');

    const state = await manager.readState();
    expect(state.version).toBe(1);
    expect(state.sessions).toEqual({});
  });

  it('should recover from an unknown future state version', async () => {
    // A `version: 2` file written by a newer build must not throw against the
    // Type.Literal(1) schema — treat it as corruption and recover to default.
    const stateFile = path.join(testDir, 'research-state.json');
    await fs.mkdir(path.dirname(stateFile), { recursive: true });
    await fs.writeFile(
      stateFile,
      JSON.stringify({ version: 2, containerId: '', containerName: '', port: 0, sessions: {}, lastUpdated: Date.now() }),
      'utf-8',
    );

    const state = await manager.readState();
    expect(state.version).toBe(1);
    expect(state.sessions).toEqual({});
  });

  it('should cleanup stale sessions (timeout)', async () => {
    await manager.addSession('stale-session', 'container');
    
    // Artificially age the session in state file
    await manager.updateState(async (state) => {
      if (state.sessions['stale-session']) {
        state.sessions['stale-session'].lastSeen = Date.now() - 10000; // 10s old
      }
      return state;
    });
    
    // Cleanup with 5s timeout
    const removed = await manager.cleanupStaleSessions(5000);
    expect(removed).toBe(1);
    
    const finalState = await manager.readState();
    expect(finalState.sessions['stale-session']).toBeUndefined();
  });

  it('should not cleanup alive sessions', async () => {
    await manager.addSession('alive-session', 'container');
    
    const removed = await manager.cleanupStaleSessions(60000);
    expect(removed).toBe(0);
    
    const finalState = await manager.readState();
    expect(finalState.sessions['alive-session']).toBeDefined();
  });

  it('should provide metrics', async () => {
    await manager.addSession('s1', 'c1');
    await manager.addSession('s2', 'c2');

    const metrics = await manager.getMetrics();
    expect(metrics.totalSessions).toBe(2);
    expect(metrics.activeSessions).toBe(2);
  });
});

describe('StateManager GPU lock', () => {
  const testDir = mkdtempSync(path.join(os.tmpdir(), 'pi-test-gpu-lock-'));
  let manager: StateManager;
  let processLifecycle: ProcessLifecycleService;
  let fileLockService: FileLockService;
  let backupManager: StateBackupManager;
  let gpuResourceService: GPUResourceService;
  let sessionManager: StateSessionManager;
  let browserManager: StateBrowserManager;
  let metricsCollector: StateMetricsCollector;
  let validator: StateValidator;

  beforeEach(async () => {
    await fs.mkdir(testDir, { recursive: true });

    // Create a process lifecycle service for tests
    processLifecycle = new ProcessLifecycleService();
    await processLifecycle.initialize();

    // Create file lock service
    const lockDirPath = path.join(testDir, '.locks');
    await fs.mkdir(lockDirPath, { recursive: true });
    fileLockService = new FileLockService({
      lockFilePath: path.join(lockDirPath, 'research-state.lock'),
    });
    await fileLockService.initialize();

    // Create backup manager
    const backupDirPath = path.join(testDir, 'backups');
    await fs.mkdir(backupDirPath, { recursive: true });
    backupManager = new StateBackupManager(
      path.join(testDir, 'research-state.json'),
      backupDirPath,
      10 // maxBackups
    );
    await backupManager.initialize();

    // Create all required dependencies
    gpuResourceService = new GPUResourceService({ processLifecycle });
    await gpuResourceService.initialize();

    sessionManager = new StateSessionManager(processLifecycle);
    await sessionManager.initialize();

    browserManager = new StateBrowserManager();
    await browserManager.initialize();

    metricsCollector = new StateMetricsCollector();
    await metricsCollector.initialize();

    validator = new StateValidator();
    await validator.initialize();

    // Create state manager with all dependencies
    manager = new StateManager({
      stateDir: testDir,
      processLifecycle,
      fileLockService,
      backupManager,
      gpuResourceService,
      sessionManager,
      browserManager,
      metricsCollector,
      validator,
    });
  });

  afterEach(async () => {
    // Cleanup state manager
    try {
      await manager.cleanup();
    } catch { /* ignore cleanup errors */ }

    // Cleanup all services
    for (const service of [validator, metricsCollector, browserManager, sessionManager, gpuResourceService, backupManager, fileLockService, processLifecycle]) {
      if (service) {
        try {
          await service.dispose();
        } catch { /* ignore */ }
      }
    }

    // Cleanup test directory
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch { /* ignore cleanup errors */ }
  });

  it('acquireGpuLock returns true and persists owner to state', async () => {
    const acquired = await manager.acquireGpuLock('session-1', 5000);
    expect(acquired).toBe(true);
    const owner = await manager.getGpuOwner();
    expect(owner).not.toBeNull();
    expect(owner!.pid).toBe(process.pid);
    expect(owner!.sessionId).toBe('session-1');
  });

  it('releaseGpuLock clears the owner', async () => {
    await manager.acquireGpuLock(undefined, 5000);
    await manager.releaseGpuLock();
    const owner = await manager.getGpuOwner();
    expect(owner).toBeNull();
  });

  it('re-entrant acquire by same PID refreshes startedAt and returns true', async () => {
    await manager.acquireGpuLock(undefined, 5000);
    const before = (await manager.getGpuOwner())!.startedAt;
    await new Promise(r => setTimeout(r, 5));
    const acquired = await manager.acquireGpuLock(undefined, 5000);
    expect(acquired).toBe(true);
    const after = (await manager.getGpuOwner())!.startedAt;
    expect(after).toBeGreaterThanOrEqual(before);
  });

  it('releaseGpuLock is a no-op when called by a non-owner PID', async () => {
    await manager.acquireGpuLock(undefined, 5000);
    await manager.releaseGpuLock(process.pid + 9999); // different PID
    const owner = await manager.getGpuOwner();
    expect(owner).not.toBeNull(); // still held
  });

  it('state validates gpuOwner shape — rejects invalid pid type', async () => {
    const state = await manager.readState();
    (state as any).gpuOwner = { pid: 'not-a-number', startedAt: Date.now() };
    await expect(manager.writeState(state)).rejects.toThrow(/Invalid state/i);
  });
});
