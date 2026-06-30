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
import { registerOrchestrationServices, initializeOrchestrationServices } from '../../../src/orchestration/service-initialization.ts';
import { resetServiceContainer } from '../../../src/core/service-registry.ts';
import * as pathmod from 'node:path';
import * as os from 'node:os';
import * as fsmod from 'node:fs';

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

  // ISOLATION: Create unique directories for this test file (mkdtempSync gives
  // a cryptographically random suffix, avoiding predictable tmp-path attacks).
  const testStateDir = fsmod.mkdtempSync(pathmod.join(os.tmpdir(), 'pi-test-state-'));
  const testKnowledgeDir = fsmod.mkdtempSync(pathmod.join(os.tmpdir(), 'pi-test-knowledge-'));

  process.env['PI_RESEARCH_STATE_DIR'] = testStateDir;
  process.env['PI_RESEARCH_KNOWLEDGE_DIR'] = testKnowledgeDir;

  logger.log(`[test] Browser available. Isolating test in: ${testStateDir} / ${testKnowledgeDir}`);
  
  // Initialize Service Registry
  try {
    registerCoreServices();
    registerInfrastructureServices();
    registerOrchestrationServices();
    // Provide a mock context for services that need it (like PlanningService)
    const mockCtx = {
      cwd: process.cwd(),
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'test', headers: {} }),
        hasConfiguredAuth: () => true,
        getAll: () => [{ id: 'test-model', provider: 'test' }],
      },
    };
    await initializeCoreServices(mockCtx);
    await initializeOrchestrationServices(mockCtx);
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
    },
    afterEach: async () => {
      // Pool teardown happens once in shutdown() / afterAll — not per-test.
    },
    shutdown: async () => {
      logger.log('[test] Shutting down browser manager and disposing services...');
      await stopBrowserManager();
      await disposeCoreServices();
      // Reset the service container entirely so the next test file that calls
      // setupLifecycle() can re-register all services cleanly.
      await resetServiceContainer();

      // CLEANUP: Remove temporary isolation directories
      try {
        if (fsmod.existsSync(testStateDir)) fsmod.rmSync(testStateDir, { recursive: true, force: true });
        if (fsmod.existsSync(testKnowledgeDir)) fsmod.rmSync(testKnowledgeDir, { recursive: true, force: true });
      } catch (err) {
        logger.warn(`[test] Cleanup failed: ${err}`);
      }
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
 * Whether tests that depend on LIVE external network success (DuckDuckGo search,
 * real web scrape) should be skipped.
 *
 * These tests pass locally (residential IP) but flake on shared CI datacenter
 * IPs: search providers rate-limit/block concurrent bursts, so live searches
 * return zero results and the assertions fail — an environment problem, not a
 * code bug. CI sets PI_RESEARCH_SKIP_LIVE_NETWORK_TESTS=true so these skip
 * VISIBLY (ctx.skip → reported as skipped, never a silent false-green pass)
 * while still running for real locally. Browser launch itself is still covered
 * in CI by the dedicated "Verify camoufox launches" step.
 */
export function skipsLiveNetwork(): boolean {
  return process.env['PI_RESEARCH_SKIP_LIVE_NETWORK_TESTS'] === 'true';
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
    dispose: async () => {},
    getDevice: () => 'cpu',
    getOriginalDevice: () => 'cpu',
  } as unknown as Embedder;
}
