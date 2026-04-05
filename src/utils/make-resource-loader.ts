/**
 * Shared ResourceLoader Factory
 *
 * Extracted from coordinator.ts and researcher.ts to avoid duplication.
 * Both files use identical ResourceLoader implementations.
 */

import type { ResourceLoader, ExtensionRuntime } from '@mariozechner/pi-coding-agent';

export function makeResourceLoader(systemPromptText: string): ResourceLoader {
  const mockRuntime: ExtensionRuntime = {
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
}
