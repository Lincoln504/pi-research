/**
 * Shared Model Registry Factory
 *
 * Single source of truth for creating a ModelRegistry with the correct auth.
 * Used by both the SDK entry point (src/sdk.ts) and the OpenClaw entry point
 * (src/openclaw-entry.ts).
 *
 * Previously this logic was duplicated (#29) — any bug fix now updates both paths.
 */

import { AuthStorage, ModelRegistry, getAgentDir } from '@earendil-works/pi-coding-agent';
import type { Model } from '@earendil-works/pi-ai';
import * as path from 'node:path';
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
  const agentDir = getAgentDir();
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

  // No explicit key: use the user's pi auth storage and model list if available.
  // ModelRegistry.create() reads embedded apiKeys from models.json providers
  // directly (via providerRequestConfigs), so glm-coding and other custom
  // providers with embedded keys are visible to hasConfiguredAuth() without
  // needing to duplicate them into AuthStorage.
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
      
      throw new Error(`Model "${modelSpec}" not found in pi's configured model registry. Check ${path.join(getAgentDir(), 'models.json')}.`);
    }
    
    // Validate format: must contain a slash OR be found as a bare model ID.
    // A bare id can exist under several providers (a user-configured authed one
    // plus pi's built-in unauthed one); prefer an authed provider so we don't
    // resolve to a keyless entry that fails at the first call.
    const allModels = registry.getAll();
    const sameId = allModels.filter(m => m.id === modelSpec);
    const authedKeys = new Set(registry.getAvailable().map(m => `${m.provider}/${m.id}`));
    const found = sameId.find(m => authedKeys.has(`${m.provider}/${m.id}`)) ?? sameId[0];
    if (found) return found;

    throw new Error(`Invalid model string "${modelSpec}". Expected "provider/id" e.g. "openai/gpt-4o".`);
  }

  // 2. Provider-only: pick first available model from that provider
  if (provider) {
    const allModels = registry.getAll();
    const found = allModels.find(m => m.provider === provider);
    if (found) return found;
  }

  // 3. First available model — prefer providers in the user's models.json order.
  //    pi-ai loads built-in providers in a fixed catalog order (openrouter is 26th).
  //    User-configured providers in models.json (e.g. glm-coding) are appended after
  //    the built-ins, so getAvailable()[0] would otherwise always pick a built-in
  //    provider even when the user has a preferred custom one. Walk models.json provider
  //    order first to respect the user's explicit configuration.
  const available = registry.getAvailable();
  if (available.length > 0) {
    const modelsJsonPath = path.join(getAgentDir(), 'models.json');
    if (fs.existsSync(modelsJsonPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(modelsJsonPath, 'utf-8'));
        const userProviderOrder: string[] = Object.keys(raw?.providers ?? {});
        for (const prov of userProviderOrder) {
          const match = available.find(m => m.provider === prov);
          if (match) return match;
        }
      } catch { /* fall through to built-in ordering */ }
    }
    return available[0]!;
  }

  // 4. Any model at all
  const all = registry.getAll();
  if (all.length > 0) return all[0]!;

  // 5. Fallback: construct minimal model from credentials when registry is empty
  // (Re-checking modelSpec with slash check is redundant but kept for logic safety)
  if (apiKey && provider && modelSpec) {
    const slashIdx = modelSpec.indexOf('/');
    if (slashIdx > 0) {
      return constructMinimalModel(
        modelSpec.slice(0, slashIdx),
        modelSpec.slice(slashIdx + 1),
        apiKey,
      );
    }
    // No slash: use the explicit provider and the modelSpec as the ID
    return constructMinimalModel(provider, modelSpec, apiKey);
  }

  throw new Error(
    `No LLM model available. Please configure your model registry (${path.join(getAgentDir(), 'models.json')}) or provide an explicit apiKey.`,
  );
}
