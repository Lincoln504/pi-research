/**
 * make-resource-loader Unit Tests
 *
 * Tests for the shared resource loader factory function.
 */

import { describe, it, expect } from 'vitest';
import { makeResourceLoader } from '../../../src/utils/make-resource-loader.ts';

describe('make-resource-loader', () => {
  const testSystemPrompt = 'You are a helpful assistant.';

  describe('resource loader structure', () => {
    it('should return a valid ResourceLoader object', () => {
      const loader = makeResourceLoader(testSystemPrompt);

      expect(loader).toBeDefined();
      expect(typeof loader.getExtensions).toBe('function');
      expect(typeof loader.getSkills).toBe('function');
      expect(typeof loader.getPrompts).toBe('function');
      expect(typeof loader.getThemes).toBe('function');
      expect(typeof loader.getAgentsFiles).toBe('function');
      expect(typeof loader.getSystemPrompt).toBe('function');
      expect(typeof loader.getAppendSystemPrompt).toBe('function');
      expect(typeof loader.extendResources).toBe('function');
      expect(typeof loader.reload).toBe('function');
    });

    it('should have all required ResourceLoader methods', () => {
      const loader = makeResourceLoader(testSystemPrompt);

      expect(Object.keys(loader)).toEqual([
        'getExtensions',
        'getSkills',
        'getPrompts',
        'getThemes',
        'getAgentsFiles',
        'getSystemPrompt',
        'getAppendSystemPrompt',
        'extendResources',
        'reload',
      ]);
    });
  });

  describe('getExtensions', () => {
    it('should return empty extensions array', () => {
      const loader = makeResourceLoader(testSystemPrompt);
      const result = loader.getExtensions();

      expect(result).toBeDefined();
      expect(result.extensions).toEqual([]);
      expect(result.errors).toEqual([]);
      expect(result.runtime).toBeDefined();
    });

    it('should include a mock runtime object', () => {
      const loader = makeResourceLoader(testSystemPrompt);
      const result = loader.getExtensions();

      expect(result.runtime).toBeDefined();
      expect(typeof result.runtime.registerProvider).toBe('function');
      expect(typeof result.runtime.unregisterProvider).toBe('function');
      expect(typeof result.runtime.sendMessage).toBe('function');
      expect(typeof result.runtime.getAllTools).toBe('function');
    });
  });

  describe('getSkills', () => {
    it('should return empty skills array', () => {
      const loader = makeResourceLoader(testSystemPrompt);
      const result = loader.getSkills();

      expect(result).toBeDefined();
      expect(result.skills).toEqual([]);
      expect(result.diagnostics).toEqual([]);
    });
  });

  describe('getPrompts', () => {
    it('should return empty prompts array', () => {
      const loader = makeResourceLoader(testSystemPrompt);
      const result = loader.getPrompts();

      expect(result).toBeDefined();
      expect(result.prompts).toEqual([]);
      expect(result.diagnostics).toEqual([]);
    });
  });

  describe('getThemes', () => {
    it('should return empty themes array', () => {
      const loader = makeResourceLoader(testSystemPrompt);
      const result = loader.getThemes();

      expect(result).toBeDefined();
      expect(result.themes).toEqual([]);
      expect(result.diagnostics).toEqual([]);
    });
  });

  describe('getAgentsFiles', () => {
    it('should return empty agents files array', () => {
      const loader = makeResourceLoader(testSystemPrompt);
      const result = loader.getAgentsFiles();

      expect(result).toBeDefined();
      expect(result.agentsFiles).toEqual([]);
    });
  });

  describe('getSystemPrompt', () => {
    it('should return the provided system prompt', () => {
      const customPrompt = 'Custom system prompt for testing.';
      const loader = makeResourceLoader(customPrompt);
      const result = loader.getSystemPrompt();

      expect(result).toBe(customPrompt);
    });

    it('should handle empty system prompt', () => {
      const loader = makeResourceLoader('');
      const result = loader.getSystemPrompt();

      expect(result).toBe('');
    });

    it('should handle multiline system prompt', () => {
      const multilinePrompt = `You are a helpful assistant.

Your role is to assist users.

Be concise and accurate.`;
      const loader = makeResourceLoader(multilinePrompt);
      const result = loader.getSystemPrompt();

      expect(result).toBe(multilinePrompt);
    });
  });

  describe('getAppendSystemPrompt', () => {
    it('should return empty array', () => {
      const loader = makeResourceLoader(testSystemPrompt);
      const result = loader.getAppendSystemPrompt();

      expect(result).toEqual([]);
    });
  });

  describe('extendResources', () => {
    it('should not throw when called', () => {
      const loader = makeResourceLoader(testSystemPrompt);

      expect(() => loader.extendResources()).not.toThrow();
    });

    it('should handle arguments without throwing', () => {
      const loader = makeResourceLoader(testSystemPrompt);

      expect(() => loader.extendResources({} as any)).not.toThrow();
      expect(() => loader.extendResources([] as any)).not.toThrow();
    });
  });

  describe('reload', () => {
    it('should not throw when called', async () => {
      const loader = makeResourceLoader(testSystemPrompt);

      await expect(loader.reload()).resolves.not.toThrow();
    });

    it('should resolve to undefined', async () => {
      const loader = makeResourceLoader(testSystemPrompt);
      const result = await loader.reload();

      expect(result).toBeUndefined();
    });
  });

  describe('runtime object behavior', () => {
    it('should have flagValues as empty Map', () => {
      const loader = makeResourceLoader(testSystemPrompt);
      const runtime = loader.getExtensions().runtime;

      expect(runtime.flagValues).toBeInstanceOf(Map);
      expect(runtime.flagValues.size).toBe(0);
    });

    it('should have pendingProviderRegistrations as empty array', () => {
      const loader = makeResourceLoader(testSystemPrompt);
      const runtime = loader.getExtensions().runtime;

      expect(runtime.pendingProviderRegistrations).toEqual([]);
    });

    it('should have registerProvider as no-op function', () => {
      const loader = makeResourceLoader(testSystemPrompt);
      const runtime = loader.getExtensions().runtime;

      expect(() => runtime.registerProvider({} as any)).not.toThrow();
    });

    it('should have unregisterProvider as no-op function', () => {
      const loader = makeResourceLoader(testSystemPrompt);
      const runtime = loader.getExtensions().runtime;

      expect(() => runtime.unregisterProvider({} as any)).not.toThrow();
    });

    it('should have sendMessage as async no-op', async () => {
      const loader = makeResourceLoader(testSystemPrompt);
      const runtime = loader.getExtensions().runtime;

      await expect(runtime.sendMessage({} as any)).resolves.not.toThrow();
    });

    it('should have sendUserMessage as async no-op', async () => {
      const loader = makeResourceLoader(testSystemPrompt);
      const runtime = loader.getExtensions().runtime;

      await expect(runtime.sendUserMessage({} as any)).resolves.not.toThrow();
    });

    it('should have appendEntry as async no-op', async () => {
      const loader = makeResourceLoader(testSystemPrompt);
      const runtime = loader.getExtensions().runtime;

      await expect(runtime.appendEntry({} as any)).resolves.not.toThrow();
    });

    it('should have setSessionName as no-op returning undefined', () => {
      const loader = makeResourceLoader(testSystemPrompt);
      const runtime = loader.getExtensions().runtime;

      const result = runtime.setSessionName('test');
      expect(result).toBeUndefined();
    });

    it('should have getSessionName as no-op returning undefined', () => {
      const loader = makeResourceLoader(testSystemPrompt);
      const runtime = loader.getExtensions().runtime;

      const result = runtime.getSessionName();
      expect(result).toBeUndefined();
    });

    it('should have setLabel as async no-op', async () => {
      const loader = makeResourceLoader(testSystemPrompt);
      const runtime = loader.getExtensions().runtime;

      await expect(runtime.setLabel({} as any)).resolves.not.toThrow();
    });

    it('should have getActiveTools returning empty array', () => {
      const loader = makeResourceLoader(testSystemPrompt);
      const runtime = loader.getExtensions().runtime;

      expect(runtime.getActiveTools()).toEqual([]);
    });

    it('should have getAllTools returning empty array', () => {
      const loader = makeResourceLoader(testSystemPrompt);
      const runtime = loader.getExtensions().runtime;

      expect(runtime.getAllTools()).toEqual([]);
    });

    it('should have setActiveTools as no-op', () => {
      const loader = makeResourceLoader(testSystemPrompt);
      const runtime = loader.getExtensions().runtime;

      expect(() => runtime.setActiveTools([])).not.toThrow();
    });

    it('should have refreshTools as no-op', () => {
      const loader = makeResourceLoader(testSystemPrompt);
      const runtime = loader.getExtensions().runtime;

      expect(() => runtime.refreshTools()).not.toThrow();
    });

    it('should have getCommands returning empty array', () => {
      const loader = makeResourceLoader(testSystemPrompt);
      const runtime = loader.getExtensions().runtime;

      expect(runtime.getCommands()).toEqual([]);
    });

    it('should have setModel as async true', async () => {
      const loader = makeResourceLoader(testSystemPrompt);
      const runtime = loader.getExtensions().runtime;

      await expect(runtime.setModel({} as any)).resolves.toBe(true);
    });

    it('should have getThinkingLevel returning "off"', () => {
      const loader = makeResourceLoader(testSystemPrompt);
      const runtime = loader.getExtensions().runtime;

      expect(runtime.getThinkingLevel()).toBe('off');
    });

    it('should have setThinkingLevel as no-op', () => {
      const loader = makeResourceLoader(testSystemPrompt);
      const runtime = loader.getExtensions().runtime;

      expect(() => runtime.setThinkingLevel('normal')).not.toThrow();
    });

    it('should have assertActive as no-op', () => {
      const loader = makeResourceLoader(testSystemPrompt);
      const runtime = loader.getExtensions().runtime;

      expect(() => runtime.assertActive()).not.toThrow();
    });

    it('should have invalidate as no-op', () => {
      const loader = makeResourceLoader(testSystemPrompt);
      const runtime = loader.getExtensions().runtime;

      expect(() => runtime.invalidate()).not.toThrow();
    });
  });

  describe('multiple instances', () => {
    it('should create independent loaders with different prompts', () => {
      const loader1 = makeResourceLoader('Prompt 1');
      const loader2 = makeResourceLoader('Prompt 2');

      expect(loader1.getSystemPrompt()).toBe('Prompt 1');
      expect(loader2.getSystemPrompt()).toBe('Prompt 2');
    });

    it('should not share state between instances', () => {
      const loader1 = makeResourceLoader('Prompt 1');
      const loader2 = makeResourceLoader('Prompt 2');

      const runtime1 = loader1.getExtensions().runtime;
      const runtime2 = loader2.getExtensions().runtime;

      expect(runtime1).not.toBe(runtime2);
    });
  });
});
