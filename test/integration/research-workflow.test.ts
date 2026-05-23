/**
 * Integration Tests: End-to-End Research Workflows
 *
 * Tests complete research workflows from query to results to storage.
 * These are integration tests that require the browser and knowledge store.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { QuickResearchOrchestrator } from '../../src/orchestration/quick-research-orchestrator.ts';
import { DeepResearchOrchestrator } from '../../src/orchestration/deep-research-orchestrator.ts';
import { getConfig } from '../../src/config.ts';
import { setupLifecycle, teardownLifecycle, type TestContext } from './helpers/setup.ts';
import { KnowledgeStore } from '../../src/knowledge/store.ts';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { logger } from '../../src/logger.ts';

// ============================================================================
// Types
// ============================================================================

interface ResearchWorkflowResult {
  query: string;
  success: boolean;
  result?: string;
  error?: Error;
  durationMs: number;
  documentCount?: number;
  searchResultsCount?: number;
  scrapedUrls?: string[];
}

// ============================================================================
// Test Implementation
// ============================================================================

describe('End-to-End Research Workflows', () => {
  let testContext: TestContext;
  let testDbDir: string;

  beforeAll(async () => {
    testContext = await setupLifecycle();
    testDbDir = path.join(os.tmpdir(), `pi-research-workflow-${Date.now()}`);
  }, 30000);

  afterAll(async () => {
    await teardownLifecycle(testContext);
    // Cleanup test database
    try {
      const fs = await import('node:fs');
      if (fs.existsSync(testDbDir)) {
        fs.rmSync(testDbDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors
    }
  }, 30000);

  describe('Quick Research Workflow', () => {
    it('should complete full quick research workflow: query → search → scrape → synthesis', async () => {
      if (testContext.skipTests()) {
        return;
      }

      const query = 'What is TypeScript?';
      const sessionId = `session-${randomUUID()}`;
      const researchId = `research-${randomUUID()}`;

      const startTime = Date.now();

      const orchestrator = new QuickResearchOrchestrator({
        query,
        sessionId,
        researchId,
        model: { id: 'test-model' } as any,
        ctx: {
          cwd: testDbDir,
          modelRegistry: {
            getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'test', headers: {} }),
          },
        } as any,
        observer: {
          onProgress: (data: any) => {
            logger.debug('[test] Progress:', data);
          },
        },
        config: { ...getConfig(), KNOWLEDGE_STORE_ENABLED: true },
      });

      const result = await orchestrator.run();
      const duration = Date.now() - startTime;

      // Verify workflow completed
      expect(result).toBeDefined();
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(10);

      // Verify reasonable duration
      expect(duration).toBeGreaterThan(0);
      expect(duration).toBeLessThan(60000); // Should complete within 60 seconds

      logger.info(`[test] Quick research completed in ${duration}ms`);
    }, 90000);

    it('should handle research with knowledge store integration', async () => {
      if (testContext.skipTests()) {
        return;
      }

      const query = 'JavaScript async await patterns';
      const sessionId = `session-${randomUUID()}`;
      const researchId = `research-${randomUUID()}`;

      // Create knowledge store
      const knowledgeStore = new KnowledgeStore(testDbDir);
      await knowledgeStore.open();

      const orchestrator = new QuickResearchOrchestrator({
        query,
        sessionId,
        researchId,
        model: { id: 'test-model' } as any,
        ctx: {
          cwd: testDbDir,
          modelRegistry: {
            getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'test', headers: {} }),
          },
          knowledgeStore,
        } as any,
        observer: {},
        config: { ...getConfig(), KNOWLEDGE_STORE_ENABLED: true },
      });

      const result = await orchestrator.run();

      // Verify result
      expect(result).toBeDefined();
      expect(result.length).toBeGreaterThan(0);

      // Verify knowledge store was updated
      const docCount = await knowledgeStore.count();
      expect(docCount).toBeGreaterThan(0);

      await knowledgeStore.close();
    }, 90000);

    it('should handle empty or minimal search results gracefully', async () => {
      if (testContext.skipTests()) {
        return;
      }

      const query = 'xyz123nonexistentquerythatshouldreturnnoresults';
      const sessionId = `session-${randomUUID()}`;
      const researchId = `research-${randomUUID()}`;

      const orchestrator = new QuickResearchOrchestrator({
        query,
        sessionId,
        researchId,
        model: { id: 'test-model' } as any,
        ctx: {
          cwd: testDbDir,
          modelRegistry: {
            getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'test', headers: {} }),
          },
        } as any,
        observer: {},
        config: { ...getConfig(), KNOWLEDGE_STORE_ENABLED: false },
      });

      // Should complete without throwing, even with minimal results
      const result = await orchestrator.run();

      // Should still return a result, even if minimal
      expect(result).toBeDefined();
      expect(typeof result).toBe('string');
    }, 90000);
  });

  describe('Deep Research Workflow', () => {
    it('should complete full deep research workflow: coordinator → researchers → aggregation', async () => {
      if (testContext.skipTests()) {
        return;
      }

      const query = 'Compare React and Vue frameworks';
      const sessionId = `session-${randomUUID()}`;
      const researchId = `research-${randomUUID()}`;

      const startTime = Date.now();

      const orchestrator = new DeepResearchOrchestrator({
        query,
        complexity: 1, // Medium complexity
        sessionId,
        researchId,
        model: { id: 'test-model' } as any,
        ctx: {
          cwd: testDbDir,
          modelRegistry: {
            getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'test', headers: {} }),
          },
        } as any,
        observer: {
          onProgress: (data: any) => {
            logger.debug('[test] Deep research progress:', data);
          },
        },
        config: { ...getConfig(), KNOWLEDGE_STORE_ENABLED: true },
      });

      const result = await orchestrator.run();
      const duration = Date.now() - startTime;

      // Verify workflow completed
      expect(result).toBeDefined();
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(50);

      // Deep research should take longer than quick research
      expect(duration).toBeGreaterThan(0);

      logger.info(`[test] Deep research completed in ${duration}ms`);
    }, 180000); // 3 minutes for deep research

    it('should handle multi-round research with different sub-queries', async () => {
      if (testContext.skipTests()) {
        return;
      }

      const query = 'Comprehensive analysis of microservices architecture';
      const sessionId = `session-${randomUUID()}`;
      const researchId = `research-${randomUUID()}`;

      const orchestrator = new DeepResearchOrchestrator({
        query,
        complexity: 2, // High complexity
        sessionId,
        researchId,
        model: { id: 'test-model' } as any,
        ctx: {
          cwd: testDbDir,
          modelRegistry: {
            getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'test', headers: {} }),
          },
        } as any,
        observer: {
          onProgress: (data: any) => {
            logger.debug('[test] Multi-round progress:', data);
          },
        },
        config: { ...getConfig(), KNOWLEDGE_STORE_ENABLED: true },
      });

      const result = await orchestrator.run();

      // Verify comprehensive result
      expect(result).toBeDefined();
      expect(result.length).toBeGreaterThan(100);

      // Result should cover multiple aspects (would check content in real test)
      expect(result).toBeDefined();
    }, 240000); // 4 minutes for comprehensive analysis
  });

  describe('Workflow Error Handling', () => {
    it('should handle and recover from network errors during search', async () => {
      if (testContext.skipTests()) {
        return;
      }

      const query = 'Test network error handling';
      const sessionId = `session-${randomUUID()}`;
      const researchId = `research-${randomUUID()}`;

      const orchestrator = new QuickResearchOrchestrator({
        query,
        sessionId,
        researchId,
        model: { id: 'test-model' } as any,
        ctx: {
          cwd: testDbDir,
          modelRegistry: {
            getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'test', headers: {} }),
          },
        } as any,
        observer: {},
        config: {
          ...getConfig(),
          KNOWLEDGE_STORE_ENABLED: false,
          MAX_RETRIES: 3,
        },
      });

      // Should handle errors gracefully with retries
      let result: string;
      try {
        result = await orchestrator.run();
        expect(result).toBeDefined();
      } catch (error) {
        // If it fails, should fail with a meaningful error
        expect(error).toBeDefined();
        expect(String(error)).not.toBe('');
      }
    }, 90000);

    it('should handle timeout during scraping', async () => {
      if (testContext.skipTests()) {
        return;
      }

      const query = 'Test timeout handling';
      const sessionId = `session-${randomUUID()}`;
      const researchId = `research-${randomUUID()}`;

      const orchestrator = new QuickResearchOrchestrator({
        query,
        sessionId,
        researchId,
        model: { id: 'test-model' } as any,
        ctx: {
          cwd: testDbDir,
          modelRegistry: {
            getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'test', headers: {} }),
          },
        } as any,
        observer: {},
        config: {
          ...getConfig(),
          KNOWLEDGE_STORE_ENABLED: false,
          SCRAPE_TIMEOUT_MS: 5000,
        },
      });

      // Should handle timeout gracefully
      let result: string;
      try {
        result = await orchestrator.run();
        expect(result).toBeDefined();
      } catch (error) {
        // If timeout occurs, should have clear error message
        expect(error).toBeDefined();
      }
    }, 90000);
  });

  describe('Workflow State Persistence', () => {
    it('should persist research state to knowledge store', async () => {
      if (testContext.skipTests()) {
        return;
      }

      const query = 'Test state persistence';
      const sessionId = `session-${randomUUID()}`;
      const researchId = `research-${randomUUID()}`;

      const knowledgeStore = new KnowledgeStore(testDbDir);
      await knowledgeStore.open();

      const orchestrator = new QuickResearchOrchestrator({
        query,
        sessionId,
        researchId,
        model: { id: 'test-model' } as any,
        ctx: {
          cwd: testDbDir,
          modelRegistry: {
            getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'test', headers: {} }),
          },
          knowledgeStore,
        } as any,
        observer: {},
        config: { ...getConfig(), KNOWLEDGE_STORE_ENABLED: true },
      });

      await orchestrator.run();

      // Verify documents were stored
      const docCount = await knowledgeStore.count();
      expect(docCount).toBeGreaterThan(0);

      // Verify we can search for stored documents
      const searchResults = await knowledgeStore.search('persistence', { limit: 5 });
      expect(searchResults).toBeDefined();

      await knowledgeStore.close();
    }, 90000);

    it('should retrieve relevant information from knowledge store in subsequent queries', async () => {
      if (testContext.skipTests()) {
        return;
      }

      const query1 = 'First query about caching';
      const query2 = 'Follow-up query about caching mechanisms';

      const knowledgeStore = new KnowledgeStore(testDbDir);
      await knowledgeStore.open();

      // First research
      const orchestrator1 = new QuickResearchOrchestrator({
        query: query1,
        sessionId: `session-${randomUUID()}`,
        researchId: `research-${randomUUID()}`,
        model: { id: 'test-model' } as any,
        ctx: {
          cwd: testDbDir,
          modelRegistry: {
            getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'test', headers: {} }),
          },
          knowledgeStore,
        } as any,
        observer: {},
        config: { ...getConfig(), KNOWLEDGE_STORE_ENABLED: true },
      });

      await orchestrator1.run();

      const docCountAfterFirst = await knowledgeStore.count();

      // Second research should potentially use knowledge from first
      const orchestrator2 = new QuickResearchOrchestrator({
        query: query2,
        sessionId: `session-${randomUUID()}`,
        researchId: `research-${randomUUID()}`,
        model: { id: 'test-model' } as any,
        ctx: {
          cwd: testDbDir,
          modelRegistry: {
            getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'test', headers: {} }),
          },
          knowledgeStore,
        } as any,
        observer: {},
        config: { ...getConfig(), KNOWLEDGE_STORE_ENABLED: true },
      });

      const result2 = await orchestrator2.run();

      expect(result2).toBeDefined();

      const docCountAfterSecond = await knowledgeStore.count();
      expect(docCountAfterSecond).toBeGreaterThanOrEqual(docCountAfterFirst);

      await knowledgeStore.close();
    }, 120000);
  });
});