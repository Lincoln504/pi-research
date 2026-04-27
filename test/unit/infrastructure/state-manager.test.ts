import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { StateManager } from '../../../src/infrastructure/state-manager.ts';

describe('StateManager Integration-style Tests', () => {
  const testDir = path.join(os.tmpdir(), `pi-test-state-${Date.now()}`);
  let manager: StateManager;

  beforeEach(async () => {
    // Ensure fresh test directory
    await fs.mkdir(testDir, { recursive: true });
    manager = new StateManager(testDir);
  });

  afterEach(async () => {
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

  it('should cleanup stale sessions (timeout)', async () => {
    await manager.addSession('stale-session', 'container');
    
    // Artificially age the session in state file
    const state = await manager.readState();
    state.sessions['stale-session']!.lastSeen = Date.now() - 10000; // 10s old
    await manager.writeState(state);
    
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
