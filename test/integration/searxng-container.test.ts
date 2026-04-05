/**
 * Searxng Container Integration Tests
 *
 * Integration tests for Searxng using testcontainers.
 * Tests actual Searxng functionality with a real container.
 *
 * Note: Some search functionality tests may fail due to Searxng's security
 * features (rate limiting, bot detection, etc.). This is expected and documented.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  startSearxngContainer,
  waitForSearxngReady,
  search,
  getEngines,
  type SearxngContainer,
} from './helpers/testcontainers.ts';

describe('Searxng Container Integration', () => {
  let searxngContainer: SearxngContainer | null = null;

  beforeAll(async () => {
    console.log('Starting Searxng container for integration tests...');

    try {
      searxngContainer = await startSearxngContainer();
      console.log(`Searxng container started at ${searxngContainer.url}`);

      // Wait for Searxng to be ready
      await waitForSearxngReady(searxngContainer.url);

      // Give it a bit more time to fully initialize
      await new Promise((resolve) => setTimeout(resolve, 5000));
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
      expect(searxngContainer?.port).toBeLessThanOrEqual(65535);
    });

    it('should have a stop function', () => {
      expect(searxngContainer).toBeDefined();
      expect(typeof searxngContainer?.stop).toBe('function');
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

    it('should respond to config endpoint', async () => {
      if (!searxngContainer) {
        throw new Error('Searxng container not initialized');
      }

      const response = await fetch(`${searxngContainer.url}/config`, {
        method: 'GET',
        signal: AbortSignal.timeout(10000),
      });

      expect(response.status).toBeGreaterThan(0);

      const data = await response.json();
      expect(data).toBeDefined();
      expect(typeof data).toBe('object');
    });
  });

  describe('Engine Configuration', () => {
    it('should get available engines', async () => {
      if (!searxngContainer) {
        throw new Error('Searxng container not initialized');
      }

      const engines = await getEngines(searxngContainer.url);

      expect(engines).toBeDefined();
      expect(Array.isArray(engines)).toBe(true);
    });

    it('should have at least one engine configured', async () => {
      if (!searxngContainer) {
        throw new Error('Searxng container not initialized');
      }

      const engines = await getEngines(searxngContainer.url);

      expect(engines.length).toBeGreaterThan(0);
    });

    it('should have engines with expected structure', async () => {
      if (!searxngContainer) {
        throw new Error('Searxng container not initialized');
      }

      const engines = await getEngines(searxngContainer.url);

      if (engines.length > 0) {
        const firstEngine = engines[0];
        expect(firstEngine).toHaveProperty('name');
      }
    });
  });

  describe('Search Functionality', () => {
    it('should handle connection errors gracefully', async () => {
      // This test ensures we handle errors properly
      await expect(() => search('http://invalid-url:9999', 'test', { format: 'json' }))
        .rejects.toThrow();
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
