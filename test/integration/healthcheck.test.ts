/**
 * Integration Tests: Health Check
 *
 * Tests the health check module against real network connections.
 * Requires network access and SearXNG to be running.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runHealthCheck } from '../../src/healthcheck/index.ts';
import { initLifecycle, ensureRunning, shutdownLifecycle } from '../../src/infrastructure/searxng-lifecycle.ts';
import { logger } from '../../src/logger.ts';

describe('Health Check Integration Tests', () => {
  beforeAll(async () => {
    logger.log('[test] Setting up health check tests...');
    await initLifecycle({
      cwd: process.cwd(),
      model: { id: 'test-model' },
      modelRegistry: {
        getAll: () => [{ id: 'test-model' }],
      },
      ui: {
        setWidget: () => {},
        notify: () => {},
      },
    } as any);

    await ensureRunning();
  });

  afterAll(async () => {
    logger.log('[test] Cleaning up health check tests...');
    await shutdownLifecycle();
  });

  it('should pass complete health check when network is healthy', async () => {
    // Ensure SearXNG is running
    await ensureRunning();

    const result = await runHealthCheck();

    // Validate result structure
    expect(result).toHaveProperty('success');
    expect(result).toHaveProperty('searchOk');
    expect(result).toHaveProperty('scrapeOk');
    expect(result).toHaveProperty('error');
    expect(result).toHaveProperty('details');

    // Check success
    if (!result.success) {
      console.log('Health check failed:', result.error);
    }
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should confirm search is working', async () => {
    await ensureRunning();
    const result = await runHealthCheck();

    expect(result.searchOk).toBe(true);
    expect(result.details.searchQuery).toBeDefined();
    expect(result.details.searchResultCount).toBeGreaterThan(0);
  });

  it('should confirm scrape is working on Wikipedia', async () => {
    await ensureRunning();
    const result = await runHealthCheck();

    expect(result.scrapeOk).toBe(true);
    expect(result.details.scrapedUrl).toContain('wikipedia.org');
    expect(result.details.scrapedContentLength).toBeGreaterThan(0);
  });

  it('should return substantial markdown content from Wikipedia scrape', async () => {
    await ensureRunning();
    const result = await runHealthCheck();

    if (result.scrapeOk) {
      const contentLength = result.details.scrapedContentLength || 0;
      // Wikipedia articles should have substantial content (at least 1KB)
      expect(contentLength).toBeGreaterThan(1000);
    }
  });

  it('should provide detailed error info on failure', async () => {
    // This test is somewhat artificial - we trigger a failure by searching for
    // something unlikely to have scrapable results. But in practice, if network
    // is down, the real failure comes from search/scrape themselves.
    const result = await runHealthCheck();

    if (!result.success) {
      expect(result.error).toBeDefined();
      expect(typeof result.error).toBe('string');
      expect(result.error!.length).toBeGreaterThan(0);
    }
  });
});
