/**
 * Integration Test Setup Helpers
 *
 * Provides utilities for checking browser availability and managing test lifecycle.
 * Allows tests to skip gracefully when dependencies (e.g. camoufox) are not available.
 */

import { isBrowserAvailable } from '../../../src/infrastructure/browser/config.ts';
import { stopBrowserManager } from '../../../src/infrastructure/browser/index.ts';
import { type Embedder } from '../../../src/knowledge/embedder.ts';
import { createHash } from 'node:crypto';
import { registerCoreServices, initializeCoreServices, disposeCoreServices } from '../../../src/core/service-initialization.ts';
import { registerInfrastructureServices } from '../../../src/infrastructure/service-initialization.ts';
import { resetServiceContainer } from '../../../src/core/service-registry.ts';

async function importLogger() {
  try {
    const module = await import('../../../src/logger.ts');
    return {
      logger: module.logger,
    };
  } catch (err) {
    throw new Error(`Failed to import logger module: ${err}`);
  }
}

export interface TestContext {
  lifecycleInitialized: boolean;
  skipTests: () => boolean;
  init: () => Promise<void>;
  shutdown: () => Promise<void>;
  beforeEach: () => Promise<void>;
  afterEach: () => Promise<void>;
}

/**
 * Setup lifecycle for integration tests
 * Skips gracefully if browser dependencies are not available
 */
export async function setupLifecycle(): Promise<TestContext> {
  const { logger } = await importLogger();
  
  if (!isBrowserAvailable()) {
    logger.warn('[test] Browser not available for integration tests (camoufox missing or FULL_MOCK_MODE active)');
    return createUninitializedContext(logger);
  }

  logger.log('[test] Browser available, initializing integration test lifecycle...');
  
  // Initialize Service Registry
  try {
    registerCoreServices();
    registerInfrastructureServices();
    // Provide a mock context for services that need it (like PlanningService)
    const mockCtx = {
      cwd: process.cwd(),
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'test', headers: {} }),
        hasConfiguredAuth: () => true,
      },
    };
    await initializeCoreServices(mockCtx);
    const { getServiceContainer } = await import('../../../src/core/service-registry.ts');
    getServiceContainer().isReady = true;
    logger.log('[test] Service Registry initialized for integration tests');
  } catch (err) {
    logger.error('[test] Failed to initialize Service Registry:', err);
    // Don't throw here, let individual tests fail if they need services
  }
  
  return {
    lifecycleInitialized: true,
    skipTests: () => false,
    init: async () => {},
    beforeEach: async () => {
      // Service Registry reset is handled in shutdown() per-file.
      // Individual tests can still call stopBrowserManager() if they need a fresh pool.
    },
    afterEach: async () => {
      // Pool teardown happens once in shutdown() / afterAll — not per-test.
      // Per-test stopBrowserManager() caused the f6621858 regression (8+ pool
      // recreations per file, each requiring a 90s Firefox startup on CI).
    },
    shutdown: async () => {
      logger.log('[test] Shutting down browser manager and disposing services...');
      await stopBrowserManager();
      await disposeCoreServices();
      // Reset the service container entirely so the next test file that calls
      // setupLifecycle() can re-register all services cleanly.  Without this,
      // registrations survive across test files in sequential (non-forked) mode
      // and registerCoreServices() throws "already registered", causing the
      // catch-block in setupLifecycle() to silently skip re-initialization.
      await resetServiceContainer();
    },
  };
}

function createUninitializedContext(logger: any): TestContext {
  return {
    lifecycleInitialized: false,
    skipTests: () => true,
    init: async () => {},
    beforeEach: async () => {},
    afterEach: async () => {},
    shutdown: async () => {
      logger.log('[test] Lifecycle not initialized, skipping teardown');
    },
  };
}

/**
 * Teardown lifecycle for integration tests
 */
export async function teardownLifecycle(context: TestContext): Promise<void> {
  await context.shutdown();
}

/**
 * Skip test if lifecycle is not initialized
 */
export function skipIfNotInitialized(context: TestContext, testFn: () => void | Promise<void>) {
  return async function() {
    if (context.skipTests()) {
      const { logger } = await importLogger();
      logger.log('[test] Skipping test - browser environment not available');
      return;
    }
    await testFn();
  };
}

/**
 * Creates a synthetic embedder for testing that doesn't require model downloads.
 */
export function makeSyntheticEmbedder(dim = 384): Embedder {
  function textToVector(text: string): Float32Array {
    const v = new Float32Array(dim);
    const h = createHash('sha256').update(text || '').digest();
    for (let i = 0; i < dim; i++) {
      v[i] = (h[i % h.length]! / 255) * 2 - 1;
    }
    return v;
  }
  return {
    isInitialized: () => true,
    getDimension: () => dim,
    initialize: async () => {},
    embed: async (text: string) => textToVector(text),
    embedMany: async (texts: string[]) => texts.map(t => textToVector(t)),
  } as unknown as Embedder;
}
