/**
 * Integration Test Setup Helpers
 *
 * Provides utilities for checking browser availability and managing test lifecycle.
 * Allows tests to skip gracefully when dependencies (e.g. camoufox) are not available.
 */

import { isBrowserAvailable, stopBrowserManager } from '../../../src/infrastructure/browser-manager.ts';
import { type Embedder } from '../../../src/knowledge/embedder.ts';
import { createHash } from 'node:crypto';

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
}

/**
 * Setup lifecycle for integration tests
 * Skips gracefully if browser dependencies are not available
 */
export async function setupLifecycle(): Promise<TestContext> {
  const { logger } = await importLogger();
  
  if (!isBrowserAvailable()) {
    logger.warn('[test] Browser (camoufox) not available, skipping integration tests');
    return createUninitializedContext(logger);
  }

  logger.log('[test] Browser available, initializing integration test lifecycle...');
  
  return {
    lifecycleInitialized: true,
    skipTests: () => false,
    init: async () => {},
    shutdown: async () => {
      logger.log('[test] Shutting down browser manager...');
      await stopBrowserManager();
    },
  };
}

function createUninitializedContext(logger: any): TestContext {
  return {
    lifecycleInitialized: false,
    skipTests: () => true,
    init: async () => {},
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
