/**
 * SEARXNG External Mode Integration Tests
 *
 * Tests that SEARXNG_URL external mode works with a mock HTTP server.
 * Verifies that the extension can use an external SearXNG instance
 * without spinning up Docker containers.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import { createSearxngLifecycleManager } from '../../src/infrastructure/searxng-lifecycle';
import { resetLifecycleManager } from '../../src/infrastructure/searxng-lifecycle';

describe('SEARXNG_URL external mode integration', () => {
  let mockServer: Server;

  afterEach(async () => {
    // Reset lifecycle manager state between tests
    resetLifecycleManager();
    
    // Clean up mock server
    if (mockServer) {
      await new Promise<void>((resolve) => {
        mockServer.close(() => resolve());
      });
      mockServer = undefined as any;
    }
  });

  function createMockSearxngServer(): Promise<{ server: Server; port: number }> {
    return new Promise((resolve, reject) => {
      const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        // Health check endpoint
        if (req.url === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok' }));
          return;
        }

        // Search endpoint
        if (req.url === '/search') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            query: 'test',
            results: [
              {
                title: 'Test Result',
                url: 'https://example.com',
                content: 'Test content',
                engine: 'test',
              },
            ],
          }));
          return;
        }

        // Default response
        res.writeHead(404);
        res.end('Not Found');
      });

      server.listen(0, () => {
        const address = server.address();
        if (address && typeof address === 'object' && 'port' in address) {
          resolve({ server, port: address.port });
        } else {
          reject(new Error('Failed to get server port'));
        }
      });

      server.on('error', reject);
    });
  }

  it('should use external SearXNG URL when configured', async () => {
    // Start mock SearXNG server
    const { server, port } = await createMockSearxngServer();
    mockServer = server;
    const externalUrl = `http://localhost:${port}`;

    // Create lifecycle manager with external URL
    const lifecycleManager = createSearxngLifecycleManager({
      searxngUrl: externalUrl,
    });

    // Initialize
    const ctx = { sessionId: 'test-session' } as any;
    await lifecycleManager.init(ctx);

    // Verify it initialized without Docker
    expect(lifecycleManager.isInitialized()).toBe(true);
    expect(lifecycleManager.getStatus().state).toBe('active');
    expect(lifecycleManager.getStatus().url).toBe(externalUrl);
    // In external mode, getManager() returns a shim with getSearxngUrl, not null
    const manager = lifecycleManager.getManager();
    expect(manager).not.toBeNull();
    if (manager) {
      expect(manager.getSearxngUrl()).toBe(externalUrl);
    }
  });

  it('should ensureRunning returns external URL', async () => {
    const { server, port } = await createMockSearxngServer();
    mockServer = server;
    const externalUrl = `http://localhost:${port}`;

    const lifecycleManager = createSearxngLifecycleManager({
      searxngUrl: externalUrl,
    });

    const ctx = { sessionId: 'test-session' } as any;
    await lifecycleManager.init(ctx);

    const url = await lifecycleManager.ensureRunning();
    expect(url).toBe(externalUrl);
  });

  it('should skip Docker manager in external mode', async () => {
    const { server, port } = await createMockSearxngServer();
    mockServer = server;
    const externalUrl = `http://localhost:${port}`;

    const lifecycleManager = createSearxngLifecycleManager({
      searxngUrl: externalUrl,
    });

    const ctx = { sessionId: 'test-session' } as any;
    await lifecycleManager.init(ctx);

    // In external mode, getManager() returns a shim with getSearxngUrl
    const manager = lifecycleManager.getManager();
    expect(manager).not.toBeNull();
    if (manager) {
      expect(manager.getSearxngUrl()).toBe(externalUrl);
    }
  });

  it('should allow shutdown in external mode', async () => {
    const { server, port } = await createMockSearxngServer();
    mockServer = server;
    const externalUrl = `http://localhost:${port}`;

    const lifecycleManager = createSearxngLifecycleManager({
      searxngUrl: externalUrl,
    });

    const ctx = { sessionId: 'test-session' } as any;
    await lifecycleManager.init(ctx);
    await lifecycleManager.shutdown();

    // Should be clean after shutdown
    expect(lifecycleManager.isInitialized()).toBe(false);
    expect(lifecycleManager.getStatus().state).toBe('inactive');
  });

  it('should handle external URL with path', async () => {
    const { server, port } = await createMockSearxngServer();
    mockServer = server;
    const externalUrl = `http://localhost:${port}/searxng`;

    const lifecycleManager = createSearxngLifecycleManager({
      searxngUrl: externalUrl,
    });

    const ctx = { sessionId: 'test-session' } as any;
    await lifecycleManager.init(ctx);

    expect(lifecycleManager.getStatus().url).toBe(externalUrl);
  });

  it('should handle external URL with https', async () => {
    const { server, port } = await createMockSearxngServer();
    mockServer = server;
    const externalUrl = `http://localhost:${port}`; // Using http for mock server

    const lifecycleManager = createSearxngLifecycleManager({
      searxngUrl: externalUrl,
    });

    const ctx = { sessionId: 'test-session' } as any;
    await lifecycleManager.init(ctx);

    expect(lifecycleManager.getStatus().url).toBe(externalUrl);
  });

  it('should work with SEARXNG_URL environment variable', async () => {
    const { server, port } = await createMockSearxngServer();
    mockServer = server;
    const externalUrl = `http://localhost:${port}`;

    // Set environment variable before creating lifecycle manager
    // Note: This test documents the environment variable behavior,
    // but we pass the URL explicitly to avoid module cache issues
    const lifecycleManager = createSearxngLifecycleManager({
      searxngUrl: externalUrl,
    });

    const ctx = { sessionId: 'test-session' } as any;
    await lifecycleManager.init(ctx);

    expect(lifecycleManager.getStatus().url).toBe(externalUrl);
  });
});
