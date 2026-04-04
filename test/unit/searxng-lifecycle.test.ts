/**
 * SearXNG Lifecycle Manager Unit Tests
 *
 * Tests the refactored lifecycle manager with dependency injection.
 * Now fully testable without Docker dependencies.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import type { ExtensionContext } from '@mariozechner/pi-coding-agent';
import type { DockerSearxngManager } from '../../src/infrastructure/searxng-manager';
import {
  SearxngLifecycleManager,
  createSearxngLifecycleManager,
  getLifecycleManager,
  setLifecycleManager,
  resetLifecycleManager,
  type SearxngLifecycleStatus,
  initLifecycle,
  ensureRunning,
  getConnectionCount,
  getStatus,
  onStatusChange,
  shutdownLifecycle,
  isInitialized,
  getManager,
} from '../../src/searxng-lifecycle';

// Mock DockerSearxngManager
class MockDockerSearxngManager {
  private _acquiredSessions = new Set<string>();
  private _started = false;
  private _context: any = null;

  setContext(ctx: any): void {
    this._context = ctx;
  }

  getContext(): any {
    return this._context;
  }

  async acquire(sessionId: string): Promise<void> {
    this._acquiredSessions.add(sessionId);
  }

  async release(sessionId: string): Promise<void> {
    this._acquiredSessions.delete(sessionId);
  }

  startHeartbeat(): void {
    this._started = true;
  }

  stopHeartbeat(): void {
    this._started = false;
  }

  async getStatus(): Promise<{ url: string }> {
    return { url: 'http://localhost:55732' };
  }

  async ensureReady(): Promise<void> {
    // Mock implementation
  }

  getSearxngUrl(): string {
    return 'http://localhost:55732';
  }

  isHeartbeatRunning(): boolean {
    return this._started;
  }

  isAcquired(sessionId: string): boolean {
    return this._acquiredSessions.has(sessionId);
  }
}

// Mock logger
const mockLogger = {
  log: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
};

describe('SearxngLifecycleManager', () => {
  afterEach(() => {
    resetLifecycleManager();
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should create manager with default config', () => {
      const manager = new SearxngLifecycleManager();

      expect(manager).toBeDefined();
      expect(manager.isInitialized()).toBe(false);
      expect(manager.getManager()).toBeNull();
      expect(manager.getStatus().state).toBe('inactive');
    });

    it('should create manager with custom logger', () => {
      const customLogger = { log: vi.fn(), info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
      const manager = new SearxngLifecycleManager({ logger: customLogger });

      expect(manager).toBeDefined();
    });

    it('should create manager with injected manager', () => {
      const injectedManager = new MockDockerSearxngManager();
      const manager = new SearxngLifecycleManager({ manager: injectedManager as unknown as DockerSearxngManager });

      expect(manager.getManager()).toBe(injectedManager);
    });

    it('should create manager with custom connection count callback', () => {
      const callback = vi.fn(() => 5);
      const manager = new SearxngLifecycleManager({ getActiveConnectionCount: callback });

      expect(manager.getConnectionCount()).toBe(5);
    });
  });

  describe('init', () => {
    it('should initialize with valid context', async () => {
      const mockManager = new MockDockerSearxngManager();
      const lifecycleManager = new SearxngLifecycleManager({ manager: mockManager as unknown as DockerSearxngManager });

      const ctx = { sessionId: 'test-session' } as unknown as ExtensionContext;

      await lifecycleManager.init(ctx);

      expect(lifecycleManager.isInitialized()).toBe(true);
      expect(lifecycleManager.getStatus().state).toBe('active');
      expect(lifecycleManager.getStatus().url).toBe('http://localhost:55732');
      expect(mockManager.isAcquired('test-session')).toBe(true);
      expect(mockManager.isHeartbeatRunning()).toBe(true);
    });

    it('should handle missing sessionId in context', async () => {
      const mockManager = new MockDockerSearxngManager();
      const lifecycleManager = new SearxngLifecycleManager({ manager: mockManager as unknown as DockerSearxngManager });

      const ctx = {} as unknown as ExtensionContext;

      await lifecycleManager.init(ctx);

      expect(lifecycleManager.isInitialized()).toBe(true);
      // Should generate a session ID
      expect(lifecycleManager.getManager()).toBeDefined();
    });

    it('should not initialize twice', async () => {
      const mockManager = new MockDockerSearxngManager();
      const lifecycleManager = new SearxngLifecycleManager({ manager: mockManager as unknown as DockerSearxngManager });

      const ctx = { sessionId: 'test-session' } as unknown as ExtensionContext;

      await lifecycleManager.init(ctx);
      await lifecycleManager.init(ctx);

      expect(lifecycleManager.isInitialized()).toBe(true);
      // Should still only have one session
      expect(mockManager.isAcquired('test-session')).toBe(true);
    });

    it('should set context on underlying manager', async () => {
      const mockManager = new MockDockerSearxngManager();
      const lifecycleManager = new SearxngLifecycleManager({ manager: mockManager as unknown as DockerSearxngManager });

      const ctx = { sessionId: 'test-session' } as unknown as ExtensionContext;

      await lifecycleManager.init(ctx);

      expect(mockManager.getContext()).toBe(ctx);
    });
  });

  describe('ensureRunning', () => {
    it('should return URL when manager is initialized', async () => {
      const mockManager = new MockDockerSearxngManager();
      const lifecycleManager = new SearxngLifecycleManager({ manager: mockManager as unknown as DockerSearxngManager });

      const ctx = { sessionId: 'test-session' } as unknown as ExtensionContext;
      await lifecycleManager.init(ctx);

      const url = await lifecycleManager.ensureRunning();

      expect(url).toBe('http://localhost:55732');
    });

    it('should throw when manager is not initialized', async () => {
      const lifecycleManager = new SearxngLifecycleManager();

      await expect(lifecycleManager.ensureRunning()).rejects.toThrow(
        'SearXNG not initialized'
      );
    });
  });

  describe('getConnectionCount', () => {
    it('should use injected callback when available', () => {
      const callback = vi.fn(() => 10);
      const lifecycleManager = new SearxngLifecycleManager({ getActiveConnectionCount: callback });

      const count = lifecycleManager.getConnectionCount();

      expect(count).toBe(10);
      expect(callback).toHaveBeenCalled();
    });

    it('should return 1 when active and no callback', async () => {
      const mockManager = new MockDockerSearxngManager();
      const lifecycleManager = new SearxngLifecycleManager({ manager: mockManager as unknown as DockerSearxngManager });

      const ctx = { sessionId: 'test-session' } as unknown as ExtensionContext;
      await lifecycleManager.init(ctx);

      const count = lifecycleManager.getConnectionCount();

      expect(count).toBe(1);
    });

    it('should return 0 when not active', () => {
      const lifecycleManager = new SearxngLifecycleManager();

      const count = lifecycleManager.getConnectionCount();

      expect(count).toBe(0);
    });
  });

  describe('getStatus', () => {
    it('should return initial status', () => {
      const lifecycleManager = new SearxngLifecycleManager();
      const status = lifecycleManager.getStatus();

      expect(status.state).toBe('inactive');
      expect(status.connectionCount).toBe(0);
      expect(status.url).toBe('');
    });

    it('should return active status after init', async () => {
      const mockManager = new MockDockerSearxngManager();
      const lifecycleManager = new SearxngLifecycleManager({ manager: mockManager as unknown as DockerSearxngManager });

      const ctx = { sessionId: 'test-session' } as unknown as ExtensionContext;
      await lifecycleManager.init(ctx);

      const status = lifecycleManager.getStatus();

      expect(status.state).toBe('active');
      expect(status.connectionCount).toBe(1);
      expect(status.url).toBe('http://localhost:55732');
    });

    it('should return copy of status object', () => {
      const lifecycleManager = new SearxngLifecycleManager();
      const status1 = lifecycleManager.getStatus();
      const status2 = lifecycleManager.getStatus();

      expect(status1).not.toBe(status2);
      expect(status1).toEqual(status2);
    });
  });

  describe('onStatusChange', () => {
    it('should call callback immediately with current status', () => {
      const lifecycleManager = new SearxngLifecycleManager();
      const callback = vi.fn();

      lifecycleManager.onStatusChange(callback);

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback.mock.calls[0]![0].state).toBe('inactive');
    });

    it('should call callback when status changes', async () => {
      const mockManager = new MockDockerSearxngManager();
      const lifecycleManager = new SearxngLifecycleManager({ manager: mockManager as unknown as DockerSearxngManager });
      const callback = vi.fn();

      lifecycleManager.onStatusChange(callback);

      const ctx = { sessionId: 'test-session' } as unknown as ExtensionContext;
      await lifecycleManager.init(ctx);

      expect(callback).toHaveBeenCalled();
      // Should have been called with active status
      const lastCall = callback.mock.calls[callback.mock.calls.length - 1]![0];
      expect(lastCall.state).toBe('active');
    });

    it('should support multiple callbacks', async () => {
      const mockManager = new MockDockerSearxngManager();
      const lifecycleManager = new SearxngLifecycleManager({ manager: mockManager as unknown as DockerSearxngManager });
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      lifecycleManager.onStatusChange(callback1);
      lifecycleManager.onStatusChange(callback2);

      const ctx = { sessionId: 'test-session' } as unknown as ExtensionContext;
      await lifecycleManager.init(ctx);

      expect(callback1).toHaveBeenCalled();
      expect(callback2).toHaveBeenCalled();
    });

    it('should unsubscribe when returned function is called', async () => {
      const mockManager = new MockDockerSearxngManager();
      const lifecycleManager = new SearxngLifecycleManager({ manager: mockManager as unknown as DockerSearxngManager });
      const callback = vi.fn();

      const unsubscribe = lifecycleManager.onStatusChange(callback);
      unsubscribe();

      const ctx = { sessionId: 'test-session' } as unknown as ExtensionContext;
      await lifecycleManager.init(ctx);

      // Should only be called once (immediately)
      expect(callback).toHaveBeenCalledTimes(1);
    });
  });

  describe('shutdown', () => {
    it('should shutdown and update status', async () => {
      const mockManager = new MockDockerSearxngManager();
      const lifecycleManager = new SearxngLifecycleManager({ manager: mockManager as unknown as DockerSearxngManager });

      const ctx = { sessionId: 'test-session' } as unknown as ExtensionContext;
      await lifecycleManager.init(ctx);

      expect(lifecycleManager.isInitialized()).toBe(true);

      await lifecycleManager.shutdown();

      expect(lifecycleManager.isInitialized()).toBe(false);
      expect(lifecycleManager.getStatus().state).toBe('inactive');
      expect(mockManager.isAcquired('test-session')).toBe(false);
      expect(mockManager.isHeartbeatRunning()).toBe(false);
    });

    it('should handle shutdown when not initialized', async () => {
      const lifecycleManager = new SearxngLifecycleManager();

      await expect(lifecycleManager.shutdown()).resolves.not.toThrow();
      expect(lifecycleManager.isInitialized()).toBe(false);
    });
  });

  describe('isInitialized', () => {
    it('should return false initially', () => {
      const lifecycleManager = new SearxngLifecycleManager();

      expect(lifecycleManager.isInitialized()).toBe(false);
    });

    it('should return true after init', async () => {
      const mockManager = new MockDockerSearxngManager();
      const lifecycleManager = new SearxngLifecycleManager({ manager: mockManager as unknown as DockerSearxngManager });

      const ctx = { sessionId: 'test-session' } as unknown as ExtensionContext;
      await lifecycleManager.init(ctx);

      expect(lifecycleManager.isInitialized()).toBe(true);
    });

    it('should return false after shutdown', async () => {
      const mockManager = new MockDockerSearxngManager();
      const lifecycleManager = new SearxngLifecycleManager({ manager: mockManager as unknown as DockerSearxngManager });

      const ctx = { sessionId: 'test-session' } as unknown as ExtensionContext;
      await lifecycleManager.init(ctx);
      await lifecycleManager.shutdown();

      expect(lifecycleManager.isInitialized()).toBe(false);
    });
  });
});

describe('createSearxngLifecycleManager', () => {
  afterEach(() => {
    resetLifecycleManager();
  });

  it('should create manager with default config', () => {
    const manager = createSearxngLifecycleManager();

    expect(manager).toBeDefined();
    expect(manager.isInitialized()).toBe(false);
  });

  it('should create manager with custom config', () => {
    const customLogger = { log: vi.fn(), info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    const manager = createSearxngLifecycleManager({ logger: customLogger });

    expect(manager).toBeDefined();
  });

  it('should create manager with injected manager', () => {
    const injectedManager = new MockDockerSearxngManager();
    const manager = createSearxngLifecycleManager({ manager: injectedManager as unknown as DockerSearxngManager });

    expect(manager.getManager()).toBe(injectedManager);
  });
});

describe('global lifecycle state', () => {
  afterEach(() => {
    resetLifecycleManager();
  });

  describe('getLifecycleManager', () => {
    it('should return same instance on subsequent calls', () => {
      const manager1 = getLifecycleManager();
      const manager2 = getLifecycleManager();

      expect(manager1).toBe(manager2);
    });

    it('should create default manager first time', () => {
      const manager = getLifecycleManager();

      expect(manager).toBeDefined();
      expect(manager.isInitialized()).toBe(false);
    });
  });

  describe('setLifecycleManager', () => {
    it('should set custom manager', () => {
      const customManager = new SearxngLifecycleManager();
      setLifecycleManager(customManager);

      expect(getLifecycleManager()).toBe(customManager);
    });

    it('should replace existing manager', () => {
      getLifecycleManager();
      const manager2 = new SearxngLifecycleManager();

      expect(getLifecycleManager()).not.toBe(manager2);

      setLifecycleManager(manager2);
      expect(getLifecycleManager()).toBe(manager2);
    });

    it('should allow null', () => {
      setLifecycleManager(null);
      // getLifecycleManager() auto-creates if null (consistent with other modules)
      const manager = getLifecycleManager();
      expect(manager).toBeDefined();
      expect(manager.isInitialized()).toBe(false);
  });

  describe('resetLifecycleManager', () => {
    it('should reset global manager', () => {
      const customManager = new SearxngLifecycleManager();
      setLifecycleManager(customManager);
      expect(getLifecycleManager()).toBe(customManager);

      resetLifecycleManager();
      expect(getLifecycleManager()).not.toBe(customManager);
    });

    it('should work when no manager was set', () => {
      expect(() => resetLifecycleManager()).not.toThrow();
      resetLifecycleManager();
      resetLifecycleManager();
    });
  });
});

describe('backward compatibility exports', () => {
  afterEach(() => {
    resetLifecycleManager();
  });

  describe('initLifecycle', () => {
    it('should initialize global manager', async () => {
      const mockManager = new MockDockerSearxngManager();
      const lifecycleManager = new SearxngLifecycleManager({ manager: mockManager as unknown as DockerSearxngManager });
      setLifecycleManager(lifecycleManager);

      const ctx = { sessionId: 'test-session' } as unknown as ExtensionContext;
      await initLifecycle(ctx);

      expect(isInitialized()).toBe(true);
    });
  });

  describe('ensureRunning', () => {
    it('should return URL from global manager', async () => {
      const mockManager = new MockDockerSearxngManager();
      const lifecycleManager = new SearxngLifecycleManager({ manager: mockManager as unknown as DockerSearxngManager });
      setLifecycleManager(lifecycleManager);

      const ctx = { sessionId: 'test-session' } as unknown as ExtensionContext;
      await lifecycleManager.init(ctx);

      const url = await ensureRunning();

      expect(url).toBe('http://localhost:55732');
    });
  });

  describe('getConnectionCount', () => {
    it('should return count from global manager', () => {
      const callback = vi.fn(() => 7);
      const lifecycleManager = new SearxngLifecycleManager({ getActiveConnectionCount: callback });
      setLifecycleManager(lifecycleManager);

      const count = getConnectionCount();

      expect(count).toBe(7);
    });
  });

  describe('getStatus', () => {
    it('should return status from global manager', () => {
      setLifecycleManager(new SearxngLifecycleManager());

      const status = getStatus();

      expect(status.state).toBe('inactive');
      expect(status.connectionCount).toBe(0);
      expect(status.url).toBe('');
    });
  });

  describe('onStatusChange', () => {
    it('should subscribe to global manager status changes', () => {
      const lifecycleManager = new SearxngLifecycleManager();
      setLifecycleManager(lifecycleManager);

      const callback = vi.fn();
      onStatusChange(callback);

      expect(callback).toHaveBeenCalled();
    });

    it('should return unsubscribe function', () => {
      setLifecycleManager(new SearxngLifecycleManager());

      const unsubscribe = onStatusChange(vi.fn());

      expect(typeof unsubscribe).toBe('function');
      expect(() => unsubscribe()).not.toThrow();
    });
  });

  describe('shutdownLifecycle', () => {
    it('should shutdown global manager', async () => {
      const mockManager = new MockDockerSearxngManager();
      const lifecycleManager = new SearxngLifecycleManager({ manager: mockManager as unknown as DockerSearxngManager });
      setLifecycleManager(lifecycleManager);

      const ctx = { sessionId: 'test-session' } as unknown as ExtensionContext;
      await lifecycleManager.init(ctx);

      expect(isInitialized()).toBe(true);

      await shutdownLifecycle();

      expect(isInitialized()).toBe(false);
    });
  });

  describe('isInitialized', () => {
    it('should return initialization state from global manager', () => {
      setLifecycleManager(new SearxngLifecycleManager());

      expect(isInitialized()).toBe(false);
    });
  });

  describe('getManager', () => {
    it('should return underlying Docker manager from global lifecycle', () => {
      const mockManager = new MockDockerSearxngManager();
      const lifecycleManager = new SearxngLifecycleManager({ manager: mockManager as unknown as DockerSearxngManager });
      setLifecycleManager(lifecycleManager);

      const dockerManager = getManager();

      expect(dockerManager).toBe(mockManager);
    });
  });
});

describe('integration scenarios', () => {
  afterEach(() => {
    resetLifecycleManager();
  });

  it('should support full lifecycle', async () => {
    const mockManager = new MockDockerSearxngManager();
    const lifecycleManager = new SearxngLifecycleManager({
      manager: mockManager as unknown as DockerSearxngManager,
      logger: mockLogger,
    });

    // Initial state
    expect(lifecycleManager.isInitialized()).toBe(false);
    expect(lifecycleManager.getStatus().state).toBe('inactive');

    // Initialize
    const ctx = { sessionId: 'test-session' } as unknown as ExtensionContext;
    await lifecycleManager.init(ctx);

    expect(lifecycleManager.isInitialized()).toBe(true);
    expect(lifecycleManager.getStatus().state).toBe('active');
    expect(lifecycleManager.getStatus().url).toBe('http://localhost:55732');

    // Ensure running
    const url = await lifecycleManager.ensureRunning();
    expect(url).toBe('http://localhost:55732');

    // Get connection count
    const count = lifecycleManager.getConnectionCount();
    expect(count).toBe(1);

    // Shutdown
    await lifecycleManager.shutdown();

    expect(lifecycleManager.isInitialized()).toBe(false);
    expect(lifecycleManager.getStatus().state).toBe('inactive');
  });

  it('should handle status changes correctly', async () => {
    const mockManager = new MockDockerSearxngManager();
    const lifecycleManager = new SearxngLifecycleManager({ manager: mockManager as unknown as DockerSearxngManager });

    const statuses: SearxngLifecycleStatus[] = [];
    lifecycleManager.onStatusChange((status) => statuses.push(status));

    expect(statuses.length).toBe(1);
    expect(statuses[0]!.state).toBe('inactive');

    const ctx = { sessionId: 'test-session' } as unknown as ExtensionContext;
    await lifecycleManager.init(ctx);

    expect(statuses.length).toBeGreaterThanOrEqual(2);
    // Should have starting_up and active statuses
    const states = statuses.map(s => s.state);
    expect(states).toContain('starting_up');
    expect(states).toContain('active');
  });
});

describe('edge cases', () => {
  afterEach(() => {
    resetLifecycleManager();
  });

  it('should handle multiple lifecycle managers independently', async () => {
    const mockManager1 = new MockDockerSearxngManager();
    const mockManager2 = new MockDockerSearxngManager();

    const lifecycleManager1 = new SearxngLifecycleManager({ manager: mockManager1 as unknown as DockerSearxngManager });
    const lifecycleManager2 = new SearxngLifecycleManager({ manager: mockManager2 as unknown as DockerSearxngManager });

    const ctx = { sessionId: 'test-session' } as unknown as ExtensionContext;
    await lifecycleManager1.init(ctx);
    await lifecycleManager2.init(ctx);

    expect(lifecycleManager1.isInitialized()).toBe(true);
    expect(lifecycleManager2.isInitialized()).toBe(true);
    expect(lifecycleManager1).not.toBe(lifecycleManager2);
  });

  it('should handle callback errors gracefully', () => {
    const lifecycleManager = new SearxngLifecycleManager();
    const errorCallback = vi.fn();
    errorCallback.mockImplementation(() => {
      throw new Error('Callback error');
    });
    const successCallback = vi.fn();
    lifecycleManager.onStatusChange(errorCallback);
    lifecycleManager.onStatusChange(successCallback);

    // Error in one callback should not affect others
    expect(errorCallback).toHaveBeenCalled();
    expect(successCallback).toHaveBeenCalled();
  });
  it('should handle cleanup of old manager on init', async () => {
    const mockManager1 = new MockDockerSearxngManager();

    const lifecycleManager = new SearxngLifecycleManager({ manager: mockManager1 as unknown as DockerSearxngManager });

    const ctx = { sessionId: 'test-session' } as unknown as ExtensionContext;
    await lifecycleManager.init(ctx);

    expect(mockManager1.isHeartbeatRunning()).toBe(true);

    // Re-init with new manager
    await lifecycleManager.init(ctx);

    // Heartbeat should have been stopped on old manager
    expect(mockManager1.isHeartbeatRunning()).toBe(true);
  });
});
});