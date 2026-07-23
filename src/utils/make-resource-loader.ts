/**
 * Shared ResourceLoader Factory
 *
 * Extracted from coordinator.ts and researcher.ts to avoid duplication.
 * Both files use identical ResourceLoader implementations.
 */

import type { ResourceLoader, ExtensionRuntime } from '@earendil-works/pi-coding-agent';

export function makeResourceLoader(systemPromptText: string): ResourceLoader {
  // Cast (not annotation) so this compiles against both pi 0.80 (no
  // pendingNativeProviderRegistrations/registerNativeProvider on ExtensionRuntime)
  // and 0.81 (where createAgentSessionServices iterates that array unconditionally).
  const mockRuntime = {
    flagValues: new Map(),
    pendingProviderRegistrations: [],
    pendingNativeProviderRegistrations: [],
    registerNativeProvider: () => {},
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
    assertActive: () => {},
    invalidate: () => {},
  } as ExtensionRuntime;

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
