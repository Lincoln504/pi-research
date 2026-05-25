/**
 * Tool Execution Integration Tests
 *
 * Tests that verify the research and health tools work correctly
 * after the service registry refactoring.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createResearchTool } from '../../src/tools/research-tool-definition.ts';
import { createHealthTool } from '../../src/tools/health-tool-definition.ts';
import { registerCoreServices, initializeCoreServices, disposeCoreServices } from '../../src/core/service-initialization.ts';
import { registerInfrastructureServices } from '../../src/infrastructure/service-initialization.ts';
import { resetServiceContainer } from '../../src/core/service-registry.ts';

describe('Tool Execution After Service Registry Refactor', () => {
  beforeAll(async () => {
    // Register all services
    registerCoreServices();
    registerInfrastructureServices();

    // Initialize core services
    const mockCtx = {
      cwd: process.cwd(),
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'test', headers: {} }),
        hasConfiguredAuth: () => true,
      },
    };
    await initializeCoreServices(mockCtx);
  });

  afterAll(async () => {
    await disposeCoreServices();
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
      
      const args = tool.prepareArguments!({
        query: 'test query',
      }) as any;

      expect(args.query).toBe('test query');
      expect(args.depth).toBe(0); // Should default to 0
    });

    it('should handle invalid depth values', () => {
      const tool = createResearchTool();
      
      const args1 = tool.prepareArguments!({
        query: 'test query',
        depth: 'invalid',
      }) as any;
      expect(args1.depth).toBe(0);

      const args2 = tool.prepareArguments!({
        query: 'test query',
        depth: 10,
      }) as any;
      expect(args2.depth).toBe(3); // Should cap at 3

      const args3 = tool.prepareArguments!({
        query: 'test query',
        depth: -1,
      }) as any;
      expect(args3.depth).toBe(0); // Should cap at 0
    });
  });

  describe('Health Tool Execution', () => {
    it('should execute health tool successfully', async () => {
      const tool = createHealthTool();
      const mockCtx = {
        cwd: process.cwd(),
        modelRegistry: {
          getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'test', headers: {} }),
          hasConfiguredAuth: () => true,
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
      expect(result.content[0].type).toBe('text');
      expect(typeof (result.content[0] as any).text).toBe('string');
      expect(result.details).toBeDefined();
    });

    it('should execute health tool with verbose flag', async () => {
      const tool = createHealthTool();
      const mockCtx = {
        cwd: process.cwd(),
        modelRegistry: {
          getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'test', headers: {} }),
          hasConfiguredAuth: () => true,
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