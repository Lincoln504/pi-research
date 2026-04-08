/**
 * SearXNG Lifecycle Manager Unit Tests
 *
 * Tests the refactored lifecycle manager with dependency injection.
 * Now fully testable without Docker dependencies.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import type { ExtensionContext } from '@mariozechner/pi-coding-agent';
import type { DockerSearxngManager } from '../../../src/infrastructure/searxng-manager.ts';
import {
  SearxngLifecycleManager,
  getLifecycleManager,
  setLifecycleManager,
  resetLifecycleManager,
  getStatus,
  onStatusChange,
  shutdownLifecycle,
  isInitialized,
  getManager,
  rewriteLocalhostProxyForContainer,
  createSearxngLifecycleManager,
} from '../../../src/infrastructure/searxng-lifecycle';

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

    it('should create manager with injected manager', () => {
      const injectedManager = new MockDockerSearxngManager();
      const manager = new SearxngLifecycleManager({ manager: injectedManager as unknown as DockerSearxngManager });

      expect(manager.getManager()).toBe(injectedManager);
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
  });

  describe('getStatus', () => {
    it('should return initial status', () => {
      const lifecycleManager = new SearxngLifecycleManager();
      const status = lifecycleManager.getStatus();

      expect(status.state).toBe('inactive');
      expect(status.url).toBe('');
    });

    it('should return active status after init', async () => {
      const mockManager = new MockDockerSearxngManager();
      const lifecycleManager = new SearxngLifecycleManager({ manager: mockManager as unknown as DockerSearxngManager });

      const ctx = { sessionId: 'test-session' } as unknown as ExtensionContext;
      await lifecycleManager.init(ctx);

      const status = lifecycleManager.getStatus();

      expect(status.state).toBe('active');
      expect(status.url).toBe('http://localhost:55732');
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

describe('rewriteLocalhostProxyForContainer', () => {
  it('rewrites localhost proxy hosts to Docker host alias', () => {
    expect(rewriteLocalhostProxyForContainer('socks5://localhost:9050'))
      .toBe('socks5://host.docker.internal:9050');
    expect(rewriteLocalhostProxyForContainer('socks5://127.0.0.1:9050'))
      .toBe('socks5://host.docker.internal:9050');
  });

  it('preserves credentials and non-local proxy hosts', () => {
    expect(rewriteLocalhostProxyForContainer('socks5://user:pass@127.0.0.1:9050'))
      .toBe('socks5://user:pass@host.docker.internal:9050');
    expect(rewriteLocalhostProxyForContainer('socks5://proxy.example.com:9050'))
      .toBe('socks5://proxy.example.com:9050');
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
    const manager = createSearxngLifecycleManager({ logger: customLogger as any });

    expect(manager).toBeDefined();
  });

  it('should create manager with injected manager', () => {
    const injectedManager = new MockDockerSearxngManager();
    const manager = createSearxngLifecycleManager({ manager: injectedManager as unknown as DockerSearxngManager });

    expect(manager.getManager()).toBe(injectedManager as any);
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
  });
});

describe('backward compatibility exports', () => {
  afterEach(() => {
    resetLifecycleManager();
  });

  describe('getStatus', () => {
    it('should return status from global manager', () => {
      setLifecycleManager(new SearxngLifecycleManager());

      const status = getStatus();

      expect(status.state).toBe('inactive');
      expect(status.url).toBe('');
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
      logger: mockLogger as any,
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

    // Shutdown
    await lifecycleManager.shutdown();

    expect(lifecycleManager.isInitialized()).toBe(false);
    expect(lifecycleManager.getStatus().state).toBe('inactive');
  });
});
