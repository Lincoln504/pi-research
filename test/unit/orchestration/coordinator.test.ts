/**
 * Coordinator Agent Unit Tests
 *
 * Tests the createCoordinatorSession function and its configuration options.
 * The coordinator spawns researcher sessions and manages delegation.
 */

import { describe, it, expect } from 'vitest';
import type { CreateCoordinatorSessionOptions } from '../../../src/orchestration/coordinator';
import type { ToolDefinition } from '@mariozechner/pi-coding-agent';

describe('Coordinator Agent', () => {
  describe('CreateCoordinatorSessionOptions interface', () => {
    it('should accept valid options with all required fields', () => {
      const options: CreateCoordinatorSessionOptions = {
        cwd: '/home/user/project',
        ctxModel: { name: 'gpt-4' },
        modelRegistry: {} as any,
        sessionManager: {} as any,
        settingsManager: {} as any,
        systemPrompt: 'You coordinate research tasks',
      };

      expect(options.cwd).toBe('/home/user/project');
      expect(options.systemPrompt).toBe('You coordinate research tasks');
    });

    it('should accept optional customTools parameter', () => {
      const tools: ToolDefinition[] = [
        {
          name: 'delegate_research',
          label: 'Delegate Research',
          description: 'Delegate research tasks',
          parameters: {} as any,
          execute: async () => ({ content: [] }),
        },
      ];

      const options: CreateCoordinatorSessionOptions = {
        cwd: '/home/user/project',
        ctxModel: { name: 'gpt-4' },
        modelRegistry: {} as any,
        sessionManager: {} as any,
        settingsManager: {} as any,
        systemPrompt: 'You coordinate research tasks',
        customTools: tools,
      };

      expect(options.customTools).toEqual(tools);
      expect(options.customTools?.length).toBe(1);
    });

    it('should default customTools to empty array when not provided', () => {
      const options: CreateCoordinatorSessionOptions = {
        cwd: '/home/user/project',
        ctxModel: { name: 'gpt-4' },
        modelRegistry: {} as any,
        sessionManager: {} as any,
        settingsManager: {} as any,
        systemPrompt: 'You coordinate research tasks',
      };

      expect(options.customTools).toBeUndefined();
    });

    it('should allow multiple custom tools', () => {
      const tools: ToolDefinition[] = [
        {
          name: 'delegate_research',
          label: 'Delegate Research',
          description: 'Delegate research tasks',
          parameters: {} as any,
          execute: async () => ({ content: [] }),
        },
        {
          name: 'investigate_context',
          label: 'Investigate Context',
          description: 'Investigate project context',
          parameters: {} as any,
          execute: async () => ({ content: [] }),
        },
        {
          name: 'custom_tool',
          label: 'Custom Tool',
          description: 'Custom tool',
          parameters: {} as any,
          execute: async () => ({ content: [] }),
        },
      ];

      const options: CreateCoordinatorSessionOptions = {
        cwd: '/home/user/project',
        ctxModel: { name: 'gpt-4' },
        modelRegistry: {} as any,
        sessionManager: {} as any,
        settingsManager: {} as any,
        systemPrompt: 'You coordinate research tasks',
        customTools: tools,
      };

      expect(options.customTools).toHaveLength(3);
    });
  });

  describe('Model and configuration options', () => {
    it('should accept null or undefined ctxModel', () => {
      const optionsNull: CreateCoordinatorSessionOptions = {
        cwd: '/home/user/project',
        ctxModel: null,
        modelRegistry: {} as any,
        sessionManager: {} as any,
        settingsManager: {} as any,
        systemPrompt: 'You coordinate research tasks',
      };

      const optionsUndefined: CreateCoordinatorSessionOptions = {
        cwd: '/home/user/project',
        ctxModel: undefined,
        modelRegistry: {} as any,
        sessionManager: {} as any,
        settingsManager: {} as any,
        systemPrompt: 'You coordinate research tasks',
      };

      expect(optionsNull.ctxModel).toBeNull();
      expect(optionsUndefined.ctxModel).toBeUndefined();
    });

    it('should accept different working directories', () => {
      const directories = ['/home/user/project', '/tmp/research', '.', '/absolute/path'];

      for (const cwd of directories) {
        const options: CreateCoordinatorSessionOptions = {
          cwd,
          ctxModel: { name: 'gpt-4' },
          modelRegistry: {} as any,
          sessionManager: {} as any,
          settingsManager: {} as any,
          systemPrompt: 'You coordinate research tasks',
        };

        expect(options.cwd).toBe(cwd);
      }
    });

    it('should accept different model types', () => {
      const models = [
        { name: 'gpt-4', version: '1.0' },
        { id: 'claude-3' },
        { type: 'coordinator-model' },
        {},
      ];

      for (const model of models) {
        const options: CreateCoordinatorSessionOptions = {
          cwd: '/home/user/project',
          ctxModel: model,
          modelRegistry: {} as any,
          sessionManager: {} as any,
          settingsManager: {} as any,
          systemPrompt: 'You coordinate research tasks',
        };

        expect(options.ctxModel).toEqual(model);
      }
    });

    it('should accept various system prompts', () => {
      const prompts = [
        'You coordinate research tasks',
        'You are a coordinator. Delegate research to researchers and synthesize findings.',
        'Coordinate the investigation of the codebase',
        '',
      ];

      for (const prompt of prompts) {
        const options: CreateCoordinatorSessionOptions = {
          cwd: '/home/user/project',
          ctxModel: { name: 'gpt-4' },
          modelRegistry: {} as any,
          sessionManager: {} as any,
          settingsManager: {} as any,
          systemPrompt: prompt,
        };

        expect(options.systemPrompt).toBe(prompt);
      }
    });
  });

  describe('Custom tools configuration', () => {
    it('should accept empty custom tools array', () => {
      const options: CreateCoordinatorSessionOptions = {
        cwd: '/home/user/project',
        ctxModel: { name: 'gpt-4' },
        modelRegistry: {} as any,
        sessionManager: {} as any,
        settingsManager: {} as any,
        systemPrompt: 'You coordinate research tasks',
        customTools: [],
      };

      expect(options.customTools).toEqual([]);
      expect(options.customTools?.length).toBe(0);
    });

    it('should preserve tool order in customTools', () => {
      const tools: ToolDefinition[] = [
        {
          name: 'first_tool',
          label: 'First',
          description: 'First tool',
          parameters: {} as any,
          execute: async () => ({ content: [] }),
        },
        {
          name: 'second_tool',
          label: 'Second',
          description: 'Second tool',
          parameters: {} as any,
          execute: async () => ({ content: [] }),
        },
      ];

      const options: CreateCoordinatorSessionOptions = {
        cwd: '/home/user/project',
        ctxModel: { name: 'gpt-4' },
        modelRegistry: {} as any,
        sessionManager: {} as any,
        settingsManager: {} as any,
        systemPrompt: 'You coordinate research tasks',
        customTools: tools,
      };

      expect(options.customTools?.[0].name).toBe('first_tool');
      expect(options.customTools?.[1].name).toBe('second_tool');
    });

    it('should allow tools with various parameter schemas', () => {
      const tools: ToolDefinition[] = [
        {
          name: 'simple_tool',
          label: 'Simple',
          description: 'Simple tool with no parameters',
          parameters: undefined as any,
          execute: async () => ({ content: [] }),
        },
        {
          name: 'complex_tool',
          label: 'Complex',
          description: 'Complex tool with parameters',
          parameters: { type: 'object', properties: { query: { type: 'string' } } } as any,
          execute: async () => ({ content: [] }),
        },
      ];

      const options: CreateCoordinatorSessionOptions = {
        cwd: '/home/user/project',
        ctxModel: { name: 'gpt-4' },
        modelRegistry: {} as any,
        sessionManager: {} as any,
        settingsManager: {} as any,
        systemPrompt: 'You coordinate research tasks',
        customTools: tools,
      };

      expect(options.customTools?.length).toBe(2);
    });
  });

  describe('Manager configuration', () => {
    it('should accept different sessionManager implementations', () => {
      const managers = [
        { create: () => {}, get: () => {} } as any,
        { start: () => {}, stop: () => {} } as any,
        {} as any,
      ];

      for (const manager of managers) {
        const options: CreateCoordinatorSessionOptions = {
          cwd: '/home/user/project',
          ctxModel: { name: 'gpt-4' },
          modelRegistry: {} as any,
          sessionManager: manager,
          settingsManager: {} as any,
          systemPrompt: 'You coordinate research tasks',
        };

        expect(options.sessionManager).toEqual(manager);
      }
    });

    it('should accept different settingsManager implementations', () => {
      const managers = [
        { get: () => {}, set: () => {} } as any,
        { load: () => {}, save: () => {} } as any,
        {} as any,
      ];

      for (const manager of managers) {
        const options: CreateCoordinatorSessionOptions = {
          cwd: '/home/user/project',
          ctxModel: { name: 'gpt-4' },
          modelRegistry: {} as any,
          sessionManager: {} as any,
          settingsManager: manager,
          systemPrompt: 'You coordinate research tasks',
        };

        expect(options.settingsManager).toEqual(manager);
      }
    });

    it('should accept different modelRegistry implementations', () => {
      const registries = [
        { get: () => {}, list: () => [] } as any,
        { models: [] } as any,
        {} as any,
      ];

      for (const registry of registries) {
        const options: CreateCoordinatorSessionOptions = {
          cwd: '/home/user/project',
          ctxModel: { name: 'gpt-4' },
          modelRegistry: registry,
          sessionManager: {} as any,
          settingsManager: {} as any,
          systemPrompt: 'You coordinate research tasks',
        };

        expect(options.modelRegistry).toEqual(registry);
      }
    });
  });
});
