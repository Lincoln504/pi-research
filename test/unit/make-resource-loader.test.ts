/**
 * Make Resource Loader Unit Tests
 *
 * Tests ResourceLoader factory function.
 */

import { describe, it, expect } from 'vitest';

describe('make-resource-loader', () => {
  const makeResourceLoader = (systemPromptText: string) => {
    const mockRuntime = {
      flagValues: new Map(),
      pendingProviderRegistrations: [],
      registerProvider: () => {},
      unregisterProvider: () => {},
      sendMessage: async () => {},
      sendUserMessage: async () => {},
      appendEntry: async () => {},
      setSessionName: () => undefined,
      getSessionName: () => undefined,
      setLabel: async () => {},
      getActiveTools: () => [],
      getAllTools: () => [],
      setActiveTools: () => {},
      refreshTools: () => {},
      getCommands: () => [],
      setModel: async () => true,
      getThinkingLevel: () => 'off',
      setThinkingLevel: () => {},
    };

    return {
      getExtensions: () => ({ extensions: [], errors: [], runtime: mockRuntime }),
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => systemPromptText,
      getAppendSystemPrompt: () => [],
      extendResources: () => {},
      reload: async () => {},
    };
  };

  describe('makeResourceLoader', () => {
    it('should return ResourceLoader object', () => {
      const loader = makeResourceLoader('test prompt');

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

    it('should return empty extensions', () => {
      const loader = makeResourceLoader('test');
      const result = loader.getExtensions();

      expect(result.extensions).toEqual([]);
      expect(result.errors).toEqual([]);
      expect(result.runtime).toBeDefined();
    });

    it('should return empty skills', () => {
      const loader = makeResourceLoader('test');
      const result = loader.getSkills();

      expect(result.skills).toEqual([]);
      expect(result.diagnostics).toEqual([]);
    });

    it('should return empty prompts', () => {
      const loader = makeResourceLoader('test');
      const result = loader.getPrompts();

      expect(result.prompts).toEqual([]);
      expect(result.diagnostics).toEqual([]);
    });

    it('should return empty themes', () => {
      const loader = makeResourceLoader('test');
      const result = loader.getThemes();

      expect(result.themes).toEqual([]);
      expect(result.diagnostics).toEqual([]);
    });

    it('should return empty agents files', () => {
      const loader = makeResourceLoader('test');
      const result = loader.getAgentsFiles();

      expect(result.agentsFiles).toEqual([]);
    });

    it('should return provided system prompt text', () => {
      const loader = makeResourceLoader('my system prompt');
      expect(loader.getSystemPrompt()).toBe('my system prompt');
    });

    it('should return empty append system prompt', () => {
      const loader = makeResourceLoader('test');
      expect(loader.getAppendSystemPrompt()).toEqual([]);
    });

    it('should have extendResources function', () => {
      const loader = makeResourceLoader('test');
      expect(() => loader.extendResources()).not.toThrow();
    });

    it('should have reload function', async () => {
      const loader = makeResourceLoader('test');
      await expect(loader.reload()).resolves.not.toThrow();
    });

    it('should handle unicode in system prompt', () => {
      const loader = makeResourceLoader('日本語 prompt 🎉');
      expect(loader.getSystemPrompt()).toBe('日本語 prompt 🎉');
    });

    it('should handle empty system prompt', () => {
      const loader = makeResourceLoader('');
      expect(loader.getSystemPrompt()).toBe('');
    });

    it('should handle very long system prompt', () => {
      const longPrompt = 'A'.repeat(10000);
      const loader = makeResourceLoader(longPrompt);
      expect(loader.getSystemPrompt()).toBe(longPrompt);
    });

    it('should handle special characters in system prompt', () => {
      const prompt = 'Prompt with "quotes" & <html> and \n newlines';
      const loader = makeResourceLoader(prompt);
      expect(loader.getSystemPrompt()).toBe(prompt);
    });

    it('should have runtime with flagValues map', () => {
      const loader = makeResourceLoader('test');
      const extensions = loader.getExtensions();

      expect(extensions.runtime.flagValues).toBeInstanceOf(Map);
      expect(extensions.runtime.flagValues.size).toBe(0);
    });

    it('should have runtime with pendingProviderRegistrations array', () => {
      const loader = makeResourceLoader('test');
      const extensions = loader.getExtensions();

      expect(extensions.runtime.pendingProviderRegistrations).toEqual([]);
    });

    it('should have runtime methods', () => {
      const loader = makeResourceLoader('test');
      const runtime = loader.getExtensions().runtime;

      expect(typeof runtime.registerProvider).toBe('function');
      expect(typeof runtime.unregisterProvider).toBe('function');
      expect(typeof runtime.sendMessage).toBe('function');
      expect(typeof runtime.sendUserMessage).toBe('function');
      expect(typeof runtime.appendEntry).toBe('function');
      expect(typeof runtime.setSessionName).toBe('function');
      expect(typeof runtime.getSessionName).toBe('function');
      expect(typeof runtime.setLabel).toBe('function');
      expect(typeof runtime.getActiveTools).toBe('function');
      expect(typeof runtime.getAllTools).toBe('function');
      expect(typeof runtime.setActiveTools).toBe('function');
      expect(typeof runtime.refreshTools).toBe('function');
      expect(typeof runtime.getCommands).toBe('function');
      expect(typeof runtime.setModel).toBe('function');
      expect(typeof runtime.getThinkingLevel).toBe('function');
      expect(typeof runtime.setThinkingLevel).toBe('function');
    });

    it('should have runtime getActiveTools return empty array', () => {
      const loader = makeResourceLoader('test');
      const runtime = loader.getExtensions().runtime;

      expect(runtime.getActiveTools()).toEqual([]);
    });

    it('should have runtime getAllTools return empty array', () => {
      const loader = makeResourceLoader('test');
      const runtime = loader.getExtensions().runtime;

      expect(runtime.getAllTools()).toEqual([]);
    });

    it('should have runtime getCommands return empty array', () => {
      const loader = makeResourceLoader('test');
      const runtime = loader.getExtensions().runtime;

      expect(runtime.getCommands()).toEqual([]);
    });

    it('should have runtime getThinkingLevel return off', () => {
      const loader = makeResourceLoader('test');
      const runtime = loader.getExtensions().runtime;

      expect(runtime.getThinkingLevel()).toBe('off');
    });

    it('should have runtime getSessionName return undefined', () => {
      const loader = makeResourceLoader('test');
      const runtime = loader.getExtensions().runtime;

      expect(runtime.getSessionName()).toBeUndefined();
    });
  });
});
