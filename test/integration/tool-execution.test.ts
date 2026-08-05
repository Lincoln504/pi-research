/**
 * Tool Execution Integration Tests
 *
 * Tests that verify the research and health tools work correctly
 * after the service registry refactoring.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createResearchTool } from '../../src/tools/research-tool-definition.ts';
import { createHealthTool } from '../../src/tools/health-tool-definition.ts';
import { registerCoreServices, initializeCoreServices, disposeCoreServices } from '../../src/core/service-initialization.ts';
import { registerInfrastructureServices } from '../../src/infrastructure/service-initialization.ts';
// resetServiceContainer imported via helpers when needed

describe('Tool Execution After Service Registry Refactor', () => {
  // Hermetic state: unlike the rest of the serial group this file does not go
  // through helpers/setup.ts setupLifecycle() (which pins these itself), so the
  // services registered below would resolve PI_RESEARCH_STATE_DIR/_KNOWLEDGE_DIR
  // to the REAL ~/.pi/research — run-semaphore slot files and knowledge state
  // racing any concurrent real run and polluting the developer's machine. Pin
  // both to per-suite tmpdirs BEFORE any service factory reads them.
  let tmpStateDir: string;
  let tmpKnowledgeDir: string;
  let realStateDir: string | undefined;
  let realKnowledgeDir: string | undefined;

  beforeAll(async () => {
    realStateDir = process.env['PI_RESEARCH_STATE_DIR'];
    realKnowledgeDir = process.env['PI_RESEARCH_KNOWLEDGE_DIR'];
    tmpStateDir = mkdtempSync(path.join(os.tmpdir(), 'pi-tool-exec-state-'));
    tmpKnowledgeDir = mkdtempSync(path.join(os.tmpdir(), 'pi-tool-exec-knowledge-'));
    process.env['PI_RESEARCH_STATE_DIR'] = tmpStateDir;
    process.env['PI_RESEARCH_KNOWLEDGE_DIR'] = tmpKnowledgeDir;

    // Register all services
    registerCoreServices();
    registerInfrastructureServices();

    // Initialize core services
    const mockCtx = {
      cwd: process.cwd(),
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'test', headers: {} }),
        hasConfiguredAuth: () => true,
        getAll: () => [{ id: 'test-model', provider: 'test' }],
      },
    };
    await initializeCoreServices(mockCtx);
    
    const { getServiceContainer } = await import('../../src/core/service-registry.ts');
    getServiceContainer().isReady = true;
  });

  afterAll(async () => {
    await disposeCoreServices();
    // Restore the ambient env exactly and drop the throwaway dirs.
    if (realStateDir === undefined) delete process.env['PI_RESEARCH_STATE_DIR'];
    else process.env['PI_RESEARCH_STATE_DIR'] = realStateDir;
    if (realKnowledgeDir === undefined) delete process.env['PI_RESEARCH_KNOWLEDGE_DIR'];
    else process.env['PI_RESEARCH_KNOWLEDGE_DIR'] = realKnowledgeDir;
    rmSync(tmpStateDir, { recursive: true, force: true });
    rmSync(tmpKnowledgeDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // Ensure services are ready before each test
  });

  afterEach(async () => {
    // Clean up but don't reset service registry (keep registrations)
  });

  describe('Tool Creation', () => {
    it('should create research tool with correct properties', () => {
      const tool = createResearchTool();
      
      expect(tool).toBeDefined();
      expect(tool.name).toBe('research');
      expect(tool.label).toBe('Research');
      expect(tool.execute).toBeDefined();
      expect(typeof tool.execute).toBe('function');
      expect(tool.description).toBeDefined();
      expect(tool.parameters).toBeDefined();
    });

    it('should create health tool with correct properties', () => {
      const tool = createHealthTool();
      
      expect(tool).toBeDefined();
      expect(tool.name).toBe('health');
      expect(tool.label).toBe('Health Check');
      expect(tool.execute).toBeDefined();
      expect(typeof tool.execute).toBe('function');
      expect(tool.description).toBeDefined();
      expect(tool.parameters).toBeDefined();
    });
  });

  describe('Tool Argument Preparation', () => {
    it('should prepare research arguments correctly', () => {
      const tool = createResearchTool();
      
      const args = tool.prepareArguments!({
        query: 'test query',
        depth: '1',
        model: 'test-model',
      }) as any;

      expect(args.query).toBe('test query');
      expect(args.depth).toBe(1);
      expect(args.model).toBe('test-model');
    });

    it('should handle missing depth parameter', () => {
      const tool = createResearchTool();
      
      // Force default depth to 1 for this test to ensure predictable fallback
      const originalDepth = process.env['PI_RESEARCH_DEFAULT_RESEARCH_DEPTH'];
      process.env['PI_RESEARCH_DEFAULT_RESEARCH_DEPTH'] = '1';
      
      try {
        const args = tool.prepareArguments!({
          query: 'test query',
        }) as any;

        expect(args.query).toBe('test query');
        // Tool schema enforces minimum: 1; depth 0 is SDK-only (not exposed via tool).
        // prepareArguments only normalizes provided values — it does not apply defaults.
        // The execute function handles default depth via rawDepth ?? config.DEFAULT_RESEARCH_DEPTH.
        expect(args.depth).toBeUndefined();
      } finally {
        if (originalDepth === undefined) {
          delete process.env['PI_RESEARCH_DEFAULT_RESEARCH_DEPTH'];
        } else {
          process.env['PI_RESEARCH_DEFAULT_RESEARCH_DEPTH'] = originalDepth;
        }
      }
    });

    it('should handle invalid depth values', () => {
      const tool = createResearchTool();

      const args1 = tool.prepareArguments!({
        query: 'test query',
        depth: 'invalid',
      }) as any;
      // Unparseable string → safe fallback of 1 (minimum valid depth)
      expect(args1.depth).toBe(1);

      const args2 = tool.prepareArguments!({
        query: 'test query',
        depth: 10,
      }) as any;
      expect(args2.depth).toBe(3); // Should cap at 3

      const args3 = tool.prepareArguments!({
        query: 'test query',
        depth: -1,
      }) as any;
      // Below-minimum depth clamped to 1 (minimum valid depth for this tool)
      expect(args3.depth).toBe(1);
    });
  });

  describe('Health Tool Execution', () => {
    it('should execute health tool successfully', async (ctx) => {
      const { isBrowserAvailable } = await import('../../src/infrastructure/browser/config.ts');
      // Visible skip, not a silent `return` that reports as PASSED while asserting
      // nothing (the false-green this file otherwise had).
      if (!isBrowserAvailable()) return ctx.skip();

      const tool = createHealthTool();
      const mockCtx = {
        cwd: process.cwd(),
        modelRegistry: {
          getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'test', headers: {} }),
          hasConfiguredAuth: () => true,
          getAll: () => [{ id: 'test-model', provider: 'test' }],
        },
      };
      
      const result = await tool.execute(
        'test-id',
        {},
        undefined,
        undefined,
        mockCtx as any
      );
      
      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
      expect(Array.isArray(result.content)).toBe(true);
      expect(result!
      .content![0].type).toBe('text');
      expect(typeof (result.content![0] as any).text).toBe('string');
      expect(result.details).toBeDefined();
    });

    it('should execute health tool with verbose flag', async (ctx) => {
      const { isBrowserAvailable } = await import('../../src/infrastructure/browser/config.ts');
      // Visible skip, not a silent `return` (see above).
      if (!isBrowserAvailable()) return ctx.skip();

      const tool = createHealthTool();
      const mockCtx = {
        cwd: process.cwd(),
        modelRegistry: {
          getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'test', headers: {} }),
          hasConfiguredAuth: () => true,
          getAll: () => [{ id: 'test-model', provider: 'test' }],
        },
      };
      
      const result = await tool.execute(
        'test-id',
        { verbose: true },
        undefined,
        undefined,
        mockCtx as any
      );
      
      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
      expect((result.content[0] as any).text).toContain('System Health Status');
    });
  });

  describe('Research Tool Error Handling', () => {
    it('should return error for empty query', async () => {
      const tool = createResearchTool();
      const mockCtx = {
        cwd: process.cwd(),
        modelRegistry: {
          getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'test', headers: {} }),
          hasConfiguredAuth: () => true,
          getAll: () => [{ id: 'test-model', provider: 'test' }],
        },
        model: {
          id: 'test-model',
        },
        ui: {
          notify: () => {},
        },
      };
      
      const result = await tool.execute(
        'test-id',
        { query: '' },
        undefined,
        undefined,
        mockCtx as any
      );
      
      expect(result).toBeDefined();
      expect((result.content[0] as any).text).toContain('Error');
    });

    it('should handle abort signal', async () => {
      const tool = createResearchTool();
      const mockCtx = {
        cwd: process.cwd(),
        modelRegistry: {
          getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'test', headers: {} }),
          hasConfiguredAuth: () => true,
          getAll: () => [{ id: 'test-model', provider: 'test' }],
        },
        model: {
          id: 'test-model',
        },
        ui: {
          notify: () => {},
        },
      };
      
      const abortController = new AbortController();
      abortController.abort(); // Immediately abort
      
      const result = await tool.execute(
        'test-id',
        { query: 'test query' },
        abortController.signal,
        undefined,
        mockCtx as any
      );
      
      expect(result).toBeDefined();
      expect((result.content[0] as any).text).toContain('Research cancelled');
    });
  });

  describe('Service Registry State After Operations', () => {
    it('should maintain service registrations after tool creation', async () => {
      const { hasService } = await import('../../src/core/service-registry.ts');
      const { ServiceNames } = await import('../../src/core/service-interfaces.ts');
      
      // Create tools (this shouldn't affect service registry)
      createResearchTool();
      createHealthTool();
      
      // Services should still be registered
      expect(hasService(ServiceNames.SCHEDULER)).toBe(true);
      expect(hasService(ServiceNames.STATE_MANAGER)).toBe(true);
      expect(hasService(ServiceNames.KNOWLEDGE_STORE)).toBe(true);
      expect(hasService(ServiceNames.PLANNING)).toBe(true);
    });

    it('should allow multiple tool executions after dispose', async () => {
      const tool = createHealthTool();
      const mockCtx = {
        cwd: process.cwd(),
        modelRegistry: {
          getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'test', headers: {} }),
          hasConfiguredAuth: () => true,
          getAll: () => [{ id: 'test-model', provider: 'test' }],
        },
      };
      
      // First execution
      const result1 = await tool.execute(
        'test-id-1',
        {},
        undefined,
        undefined,
        mockCtx as any
      );
      expect(result1).toBeDefined();
      
      // Dispose services (simulating cleanup between operations)
      await disposeCoreServices();
      
      // Second execution should still work because registrations are preserved
      const result2 = await tool.execute(
        'test-id-2',
        {},
        undefined,
        undefined,
        mockCtx as any
      );
      expect(result2).toBeDefined();
    });
  });
});
