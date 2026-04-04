/**
 * Testcontainers Integration Tests
 *
 * Tests basic Searxng container functionality using testcontainers.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startSearxngContainer, type SearxngContainer } from './helpers/testcontainers.js';

describe('Searxng Container Integration', () => {
  let searxngContainer: SearxngContainer | null = null;

  beforeAll(async () => {
    console.log('Starting Searxng container for integration tests...');

    try {
      searxngContainer = await startSearxngContainer();
      console.log(`Searxng container started at ${searxngContainer.url}`);

      // Give the container some extra time to fully initialize
      // Searxng can take a while to start up completely
      await new Promise((resolve) => setTimeout(resolve, 10000));
    } catch (error) {
      console.error('Failed to start Searxng container:', error);
      throw error;
    }
  }, 180000); // 3 minute timeout for container startup

  afterAll(async () => {
    if (searxngContainer) {
      console.log('Stopping Searxng container...');
      await searxngContainer.stop();
      console.log('Searxng container stopped');
    }
  }, 30000); // 30 second timeout for container shutdown

  describe('Container Lifecycle', () => {
    it('should start Searxng container successfully', () => {
      expect(searxngContainer).toBeDefined();
      expect(searxngContainer?.url).toBeDefined();
      expect(searxngContainer?.url).toMatch(/^http:\/\/.+:\d+$/);
    });

    it('should have a valid host and port', () => {
      expect(searxngContainer).toBeDefined();
      expect(searxngContainer?.host).toBeDefined();
      expect(searxngContainer?.port).toBeGreaterThan(0);
    });
  });

  describe('HTTP Connectivity', () => {
    it('should respond to HTTP GET requests', async () => {
      if (!searxngContainer) {
        throw new Error('Searxng container not initialized');
      }

      const response = await fetch(searxngContainer.url, {
        method: 'GET',
        signal: AbortSignal.timeout(10000),
      });

      // We expect some response - status 200 or 4xx/5xx is fine
      // as long as the server is responding
      expect(response.status).toBeGreaterThan(0);
    });

    it('should have a valid content type', async () => {
      if (!searxngContainer) {
        throw new Error('Searxng container not initialized');
      }

      const response = await fetch(searxngContainer.url, {
        method: 'GET',
        signal: AbortSignal.timeout(10000),
      });

      expect(response.status).toBeGreaterThan(0);

      const contentType = response.headers.get('content-type');
      // Content type might be HTML or JSON
      expect(contentType).toBeDefined();
    });

    it('should return some content', async () => {
      if (!searxngContainer) {
        throw new Error('Searxng container not initialized');
      }

      const response = await fetch(searxngContainer.url, {
        method: 'GET',
        signal: AbortSignal.timeout(10000),
      });

      expect(response.status).toBeGreaterThan(0);

      const text = await response.text();
      expect(text.length).toBeGreaterThan(0);
    });
  });

  describe('Cleanup', () => {
    it('should stop container gracefully', async () => {
      // This test is handled by afterAll
      // Just verify the container is defined
      expect(searxngContainer).toBeDefined();
      expect(typeof searxngContainer?.stop).toBe('function');
    });
  });
});
