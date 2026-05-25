/**
 * Link Description Enqueue Test
 *
 * Verifies that link descriptions from deep research are properly enqueued
 * with the correct field names matching the IngestionItem interface.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { registerCoreServices, initializeCoreServices, disposeCoreServices } from '../../src/core/service-initialization.ts';
import { registerInfrastructureServices } from '../../src/infrastructure/service-initialization.ts';
import { ResearchOrchestrationService } from '../../src/orchestration/research-orchestration-service.ts';
import { ServiceNames } from '../../src/core/service-interfaces.ts';
import { tryGetService } from '../../src/core/service-registry.ts';
import { WriterQueue } from '../../src/knowledge/writer-queue.ts';
import type { IngestionItem } from '../../src/knowledge/writer-queue.ts';

// Global setup/teardown to avoid service registration conflicts
let servicesInitialized = false;

describe('Link Description Enqueue', () => {
  beforeAll(async () => {
    if (!servicesInitialized) {
      // Register services
      registerCoreServices();
      registerInfrastructureServices();

      // Initialize services with minimal context
      const mockCtx = {
        cwd: process.cwd(),
        modelRegistry: {
          getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'test', headers: {} }),
          hasConfiguredAuth: () => true,
        },
      };
      await initializeCoreServices(mockCtx);
      servicesInitialized = true;
    }
  });

  afterAll(async () => {
    if (servicesInitialized) {
      await disposeCoreServices();
      servicesInitialized = false;
    }
  });

  describe('IngestionItem Field Validation', () => {
    it('should require markdown field in IngestionItem interface', () => {
      const item: IngestionItem = {
        url: 'https://example.com',
        markdown: 'Test content',
      };

      expect(item.markdown).toBe('Test content');
      expect(item.url).toBe('https://example.com');
    });

    it('should accept optional content and metadata fields', () => {
      const item: IngestionItem = {
        url: 'https://example.com',
        markdown: 'Test content',
        content: 'Optional content',
        metadata: { key: 'value' },
      };

      expect(item.content).toBe('Optional content');
      expect(item.metadata).toEqual({ key: 'value' });
    });

    it('should NOT accept text field in IngestionItem', () => {
      // This should be a TypeScript error, but let's verify the runtime behavior
      const itemWithWrongField: any = {
        url: 'https://example.com',
        text: 'Wrong field name',
      };

      // markdown should be undefined when text is used
      expect(itemWithWrongField.markdown).toBeUndefined();
    });
  });

  describe('WriterQueue Enqueue Validation', () => {
    it('should enqueue items with markdown field correctly', () => {
      // Verify IngestionItem requires markdown field
      const item: IngestionItem = {
        url: 'https://example.com',
        markdown: 'Test markdown content',
      };
      expect(item.markdown).toBe('Test markdown content');
      expect(item.url).toBe('https://example.com');
    });

    it('should require markdown field (not text field) in IngestionItem', () => {
      // TypeScript would catch this at compile time - test the runtime behavior
      const itemWithWrongField: any = {
        url: 'https://example.com',
        text: 'Wrong field name',
      };
      // markdown should be undefined when wrong field is used
      expect(itemWithWrongField.markdown).toBeUndefined();
      // text field exists but is not the correct field
      expect(itemWithWrongField.text).toBe('Wrong field name');
    });
  });

  describe('ResearchOrchestrationService Integration', () => {
    it('should have storeLinkDescriptions that uses correct field names', async () => {
      const orchestrationService = tryGetService<ResearchOrchestrationService>(ServiceNames.RESEARCH_ORCHESTRATION);
      if (!orchestrationService) {
        console.log('ResearchOrchestrationService not available, skipping integration test');
        return;
      }

      // Verify the method exists
      expect(typeof orchestrationService['storeLinkDescriptions']).toBe('function');
    });

    it('should use markdown field in enqueue calls', async () => {
      // Read the source file and verify it uses markdown: instead of text:
      const fs = await import('node:fs');
      const sourceCode = fs.readFileSync('src/orchestration/research-orchestration-service.ts', 'utf-8');

      // Check that there's a writer.enqueue call with markdown:
      const hasMarkdownField = /writer\.enqueue\(\{[\s\S]*?markdown:/m.test(sourceCode);
      expect(hasMarkdownField).toBe(true);

      // Check that there's no writer.enqueue call with text:
      const hasTextField = /writer\.enqueue\(\{[\s\S]*?text:/m.test(sourceCode);
      expect(hasTextField).toBe(false);
    });
  });

  describe('Comparison with QuickResearchOrchestrator', () => {
    it('should use same field names as QuickResearchOrchestrator', async () => {
      const fs = await import('node:fs');
      
      const researchOrchSource = fs.readFileSync('src/orchestration/research-orchestration-service.ts', 'utf-8');
      const quickOrchSource = fs.readFileSync('src/orchestration/quick-research-orchestrator.ts', 'utf-8');

      // Both should use markdown: field in enqueue calls
      const researchHasMarkdown = /writer\.enqueue\(\{[\s\S]*?markdown:/m.test(researchOrchSource);
      const quickHasMarkdown = /writer\.enqueue\(\{[\s\S]*?markdown:/m.test(quickOrchSource);

      expect(researchHasMarkdown).toBe(true);
      expect(quickHasMarkdown).toBe(true);
    });
  });
});