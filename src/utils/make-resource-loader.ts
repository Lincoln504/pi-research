/**
 * Shared ResourceLoader Factory
 *
 * Extracted from coordinator.ts and researcher.ts to avoid duplication.
 * Both files use identical ResourceLoader implementations.
 */

import { createExtensionRuntime, type ResourceLoader } from '@earendil-works/pi-coding-agent';

export function makeResourceLoader(systemPromptText: string): ResourceLoader {
  // Use pi's own createExtensionRuntime() instead of hand-maintaining a mock.
  //
  // A literal mock object drifted out of sync with the ExtensionRuntime contract:
  // pi 0.81.0 ("Full provider extensions") added `pendingNativeProviderRegistrations`
  // + `registerNativeProvider`, which this mock omitted. Under pi >= 0.81.0 the
  // host's runner.bindCore() / createAgentSessionServices() iterate that field —
  // `for (... of runtime.pendingNativeProviderRegistrations)` — and an `undefined`
  // field threw `this.runtime.pendingNativeProviderRegistrations is not iterable`,
  // aborting EVERY researcher session ("Research produced no report — no source
  // material was collected"). createExtensionRuntime() always returns a runtime
  // that satisfies the current host's full contract, so this can't drift again.
  const mockRuntime = createExtensionRuntime();

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
