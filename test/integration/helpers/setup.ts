/**
 * Integration Test Setup Helpers
 *
 * Provides utilities for checking Docker availability and lifecycle initialization
 * in integration tests. Allows tests to skip gracefully when dependencies are not available.
 */

import type { ExtensionContext } from '@mariozechner/pi-coding-agent';

// Use dynamic imports to avoid issues when modules aren't available
async function importLifecycle() {
  try {
    const module = await import('../../../src/infrastructure/searxng-lifecycle.ts');
    return {
      initLifecycle: module.initLifecycle,
      ensureRunning: module.ensureRunning,
      shutdownLifecycle: module.shutdownLifecycle,
    };
  } catch (err) {
    throw new Error(`Failed to import lifecycle module: ${err}`);
  }
}

async function importDockerManager() {
  try {
    const module = await import('../../../src/infrastructure/searxng-manager.ts');
    return {
      verifyDockerInstalled: module.verifyDockerInstalled,
    };
  } catch (err) {
    throw new Error(`Failed to import Docker manager module: ${err}`);
  }
}

async function importLogger() {
  try {
    // Use relative path from test directory
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
 * Skips gracefully if Docker is not available
 */
export async function setupLifecycle(): Promise<TestContext> {
  const { logger } = await importLogger();
  logger.log('[test] Checking Docker availability...');
  
  try {
    const { verifyDockerInstalled } = await importDockerManager();
    const dockerInfo = await verifyDockerInstalled();
    
    if (!dockerInfo.installed || !dockerInfo.running) {
      logger.warn('[test] Docker not available, skipping lifecycle initialization');
      return createUninitializedContext(logger);
    }

    logger.log('[test] Docker available, initializing lifecycle...');
    
    const { initLifecycle, ensureRunning } = await importLifecycle();
    
    const mockExtensionCtx: ExtensionContext = {
      cwd: process.cwd(),
      ui: {
        setWidget: () => {},
        notify: () => {},
      },
    } as any;
    
    await initLifecycle(mockExtensionCtx);
    await ensureRunning();
    
    const { shutdownLifecycle } = await importLifecycle();
    
    logger.log('[test] Lifecycle initialized successfully');
    return createInitializedContext(logger, shutdownLifecycle);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[test] Failed to initialize lifecycle: ${message}`);
    return createUninitializedContext(logger);
  }
}

function createInitializedContext(logger: any, shutdownFn: () => Promise<void>): TestContext {
  return {
    lifecycleInitialized: true,
    skipTests: () => false,
    init: async () => {},
    shutdown: async () => {
      logger.log('[test] Shutting down lifecycle...');
      try {
        await shutdownFn();
        logger.log('[test] Lifecycle shut down successfully');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`[test] Error during teardown: ${message}`);
      }
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
      logger.log('[test] Skipping test - lifecycle not initialized');
      return;
    }
    await testFn();
  };
}
