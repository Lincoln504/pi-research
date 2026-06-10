/**
 * Shared Model Registry Factory
 *
 * Single source of truth for creating a ModelRegistry with the correct auth.
 * Used by both the SDK entry point (src/sdk.ts) and the OpenClaw entry point
 * (src/openclaw-entry.ts).
 *
 * Previously this logic was duplicated (#29) — any bug fix now updates both paths.
 */

import { AuthStorage, ModelRegistry } from '@earendil-works/pi-coding-agent';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

/**
 * Create a ModelRegistry with the given credentials.
 *
 * @param apiKey  - Optional explicit API key
 * @param provider - Optional provider name to key the API key under
 * @returns A configured ModelRegistry
 */
export function buildModelRegistry(apiKey?: string, provider?: string): ModelRegistry {
  const agentDir = path.join(os.homedir(), '.pi', 'agent');
  const modelsJsonPath = path.join(agentDir, 'models.json');
  const authPath = path.join(agentDir, 'auth.json');

  if (apiKey && provider) {
    // Explicit key: seed InMemory storage under the correct provider name.
    const authStorage = AuthStorage.inMemory({
      [provider]: { type: 'api_key', key: apiKey },
    });
    return ModelRegistry.create(
      authStorage,
      fs.existsSync(modelsJsonPath) ? modelsJsonPath : undefined,
    );
  }

  // No explicit key: use the user's pi auth storage and model list if available
  if (fs.existsSync(authPath)) {
    const authStorage = AuthStorage.create(authPath);
    return ModelRegistry.create(
      authStorage,
      fs.existsSync(modelsJsonPath) ? modelsJsonPath : undefined,
    );
  }

  // Last resort: in-memory with nothing — will fail at LLM call time with actionable error
  return ModelRegistry.inMemory(AuthStorage.inMemory());
}
