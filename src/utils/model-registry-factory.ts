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
import type { Model } from '@earendil-works/pi-ai';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

/**
 * Headers commonly required by third-party LLM providers
 */
function buildHeaders(provider?: string): Record<string, string> {
  if (provider === 'openrouter') return { 'HTTP-Referer': 'https://pi.ai', 'X-Title': 'pi-research' };
  return {};
}

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

/**
 * Construct a minimal Model object directly from provider + modelId + apiKey.
 *
 * Used when the user provides credentials but has no pi config directory
 * (e.g., SDK users, OpenClaw plugin users without pi installed).
 * Bypasses the full ModelRegistry which would fail without models.json.
 */
export function constructMinimalModel(provider: string, modelId: string, _apiKey: string): Model<any> {
  return {
    provider,
    id: modelId,
    name: modelId,
    api: provider === 'openai' ? 'openai-completions' : (provider + '-conversations' as any),
    baseUrl: '', // Provider-specific base URLs are handled by pi-ai internal registry
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 32_768,
    headers: buildHeaders(provider),
  } as unknown as Model<any>;
}

/**
 * Resolve a Model instance from a registry based on an optional model string or provider.
 *
 * @param registry - The ModelRegistry to search in
 * @param modelSpec - Optional model string ("provider/modelId" or "modelId")
 * @param provider - Optional provider name to use as fallback
 * @param apiKey - Optional API key to construct a fallback model when registry is empty
 * @returns The resolved Model instance
 * @throws Error if no model can be resolved
 */
export function resolveModel(registry: ModelRegistry, modelSpec?: string, provider?: string, apiKey?: string): Model<any> {
  // 1. Explicit model string: "provider/modelId" or "modelId"
  if (modelSpec) {
    const slashIdx = modelSpec.indexOf('/');
    if (slashIdx > 0) {
      const prov = modelSpec.slice(0, slashIdx);
      const modelId = modelSpec.slice(slashIdx + 1);
      const found = registry.find(prov, modelId);
      if (found) return found;
      
      // Fallback for SDK/OpenClaw users without pi config: construct model from credentials
      if (apiKey && provider) {
        return constructMinimalModel(prov, modelId, apiKey);
      }
      
      throw new Error(`Model "${modelSpec}" not found in pi's configured model registry. Check ~/.pi/agent/models.json.`);
    }
    
    // Validate format: must contain a slash OR be found as a bare model ID
    const allModels = registry.getAll();
    const found = allModels.find(m => m.id === modelSpec);
    if (found) return found;

    throw new Error(`Invalid model string "${modelSpec}". Expected "provider/id" e.g. "openai/gpt-4o".`);
  }

  // 2. Provider-only: pick first available model from that provider
  if (provider) {
    const allModels = registry.getAll();
    const found = allModels.find(m => m.provider === provider);
    if (found) return found;
  }

  // 3. First available model with auth
  const available = registry.getAvailable();
  if (available.length > 0) return available[0]!;

  // 4. Any model at all
  const all = registry.getAll();
  if (all.length > 0) return all[0]!;

  // 5. Fallback: construct minimal model from credentials when registry is empty
  if (apiKey && provider && modelSpec) {
    const slashIdx = modelSpec.indexOf('/');
    if (slashIdx > 0) {
      return constructMinimalModel(
        modelSpec.slice(0, slashIdx),
        modelSpec.slice(slashIdx + 1),
        apiKey,
      );
    }
    return constructMinimalModel(provider, modelSpec, apiKey);
  }

  throw new Error(
    'No LLM model available. Please configure your model registry (~/.pi/agent/models.json) or provide an explicit apiKey.',
  );
}
