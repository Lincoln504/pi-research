/**
 * Shared Model Registry Factory
 *
 * Single source of truth for creating a ModelRegistry with the correct auth.
 * Used by the SDK entry point (src/sdk.ts), which also backs the bundled
 * `pi-research` CLI and the cross-harness agent skill.
 *
 * Previously this logic was duplicated (#29) — any bug fix now updates both paths.
 */

import { AuthStorage, ModelRegistry, getAgentDir } from '@earendil-works/pi-coding-agent';
import type { Model } from '@earendil-works/pi-ai';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { logger } from '../../logger.ts';

/**
 * A structural subset of ModelRegistry that the research resolvers actually use.
 * The registry object can arrive from two places — our own factory and the pi
 * extension host (ctx.modelRegistry) — and a version skew
 * between the pi-coding-agent we build against and the one the host injects has
 * historically produced "modelRegistry.getAvailable is not a function" crashes
 * mid-research. Treating the registry structurally (and feature-detecting each
 * method) keeps researchers alive across that skew instead of throwing a raw
 * TypeError that aborts the run.
 */
export interface ModelRegistryLike {
  getAll?: () => Model<any>[];
  getAvailable?: () => Model<any>[];
  find?: (provider: string, id: string) => Model<any> | undefined;
  getApiKeyAndHeaders?: (model: Model<any>) => Promise<AuthResultLike>;
}

/**
 * Structural result of {@link ModelRegistryLike.getApiKeyAndHeaders}. Mirrors the
 * pi-coding-agent `ApiKeyAndHeaders` discriminated union without importing it, so
 * a host skew on the concrete type can't break our build.
 */
export type AuthResultLike =
  | { ok: true; apiKey?: string; headers?: Record<string, string> }
  | { ok: false; error: string };

/** Safe `getAll()` — returns [] if the host registry lacks the method. */
export function safeGetAll(registry: ModelRegistryLike | null | undefined): Model<any>[] {
  if (registry && typeof registry.getAll === 'function') {
    try { return registry.getAll() ?? []; } catch (err) {
      logger.warn('[ModelRegistry] getAll() threw; treating as empty:', err);
    }
  }
  return [];
}

/**
 * Safe `getAvailable()` — the authed/usable subset. Falls back to getAll() when
 * the host registry does not expose getAvailable() (older/newer host skew), so a
 * missing method degrades to "treat every known model as available" rather than
 * crashing the researcher.
 */
export function safeGetAvailable(registry: ModelRegistryLike | null | undefined): Model<any>[] {
  if (registry && typeof registry.getAvailable === 'function') {
    try { return registry.getAvailable() ?? []; } catch (err) {
      logger.warn('[ModelRegistry] getAvailable() threw; falling back to getAll():', err);
    }
  } else if (registry) {
    logger.warn('[ModelRegistry] host registry has no getAvailable(); falling back to getAll(). Possible pi-coding-agent version skew.');
  }
  return safeGetAll(registry);
}

/**
 * Safe `getApiKeyAndHeaders()` — resolves LLM credentials for a model. The
 * registry can arrive from the pi extension host (ctx.modelRegistry), so a
 * version skew that renamed/removed this method must NOT throw a raw TypeError
 * mid-research (the same failure class {@link safeGetAvailable} guards against).
 * A missing method or a throw degrades to a structured `{ ok: false }` that every
 * caller already branches on, instead of aborting the run.
 */
export async function safeGetApiKeyAndHeaders(
  registry: ModelRegistryLike | null | undefined,
  model: Model<any>,
): Promise<AuthResultLike> {
  if (!registry || typeof registry.getApiKeyAndHeaders !== 'function') {
    logger.warn('[ModelRegistry] host registry has no getApiKeyAndHeaders(); cannot resolve LLM credentials. Possible pi-coding-agent version skew.');
    return { ok: false, error: 'model registry does not expose getApiKeyAndHeaders() (pi-coding-agent version skew)' };
  }
  try {
    return await registry.getApiKeyAndHeaders(model);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('[ModelRegistry] getApiKeyAndHeaders() threw; treating as auth failure:', msg);
    return { ok: false, error: msg };
  }
}

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

  // No explicit key: use the user's pi configuration when EITHER file exists.
  // ModelRegistry.create() reads embedded apiKeys from models.json providers
  // directly (via providerRequestConfigs), so custom providers with embedded
  // keys work with no auth.json at all — auth.json presence must not gate
  // models.json (AuthStorage.create tolerates a missing file). Env provider
  // keys (e.g. OPENAI_API_KEY) are honored by AuthStorage in every branch.
  if (fs.existsSync(authPath) || fs.existsSync(modelsJsonPath)) {
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
 * (e.g., SDK / CLI / agent-skill users without pi installed).
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
      const found = typeof registry.find === 'function'
        ? registry.find(prov, modelId)
        : safeGetAll(registry).find(m => m.provider === prov && m.id === modelId);
      if (found) return found;
      
      // Fallback for SDK / CLI / skill users without pi config: construct model from credentials
      if (apiKey && provider) {
        return constructMinimalModel(prov, modelId, apiKey);
      }
      
      throw new Error(`Model "${modelSpec}" not found in pi's configured model registry. Check ${path.join(getAgentDir(), 'models.json')}.`);
    }
    
    // Validate format: must contain a slash OR be found as a bare model ID.
    // A bare id can exist under several providers (a user-configured authed one
    // plus pi's built-in unauthed one); prefer an authed provider so we don't
    // resolve to a keyless entry that fails at the first call.
    const allModels = safeGetAll(registry);
    const sameId = allModels.filter(m => m.id === modelSpec);
    const authedKeys = new Set(safeGetAvailable(registry).map(m => `${m.provider}/${m.id}`));
    const found = sameId.find(m => authedKeys.has(`${m.provider}/${m.id}`)) ?? sameId[0];
    if (found) return found;

    throw new Error(`Invalid model string "${modelSpec}". Expected "provider/id" e.g. "openai/gpt-4o".`);
  }

  // 2. Provider-only: pick first available model from that provider
  if (provider) {
    const allModels = safeGetAll(registry);
    const found = allModels.find(m => m.provider === provider);
    if (found) return found;
  }

  // 3. First available model — prefer providers in the user's models.json order.
  //    pi-ai loads built-in providers in a fixed catalog order (openrouter is 26th).
  //    User-configured providers in models.json (e.g. glm-coding) are appended after
  //    the built-ins, so getAvailable()[0] would otherwise always pick a built-in
  //    provider even when the user has a preferred custom one. Walk models.json provider
  //    order first to respect the user's explicit configuration.
  const available = safeGetAvailable(registry);
  if (available.length > 0) {
    return pickPreferredAvailable(available, readModelsJsonProviderOrder())!;
  }

  // 4. Any model at all
  const all = safeGetAll(registry);
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

/**
 * Read the user's provider order from ~/.pi/agent/models.json.
 * Returns provider keys in document (insertion) order, or [] when the file is
 * absent or malformed. Kept separate from {@link pickPreferredAvailable} so the
 * selection logic stays pure and unit-testable without touching the filesystem.
 */
export function readModelsJsonProviderOrder(): string[] {
  const modelsJsonPath = path.join(getAgentDir(), 'models.json');
  if (!fs.existsSync(modelsJsonPath)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(modelsJsonPath, 'utf-8'));
    return Object.keys(raw?.providers ?? {});
  } catch (err) {
    // Malformed models.json only affects provider-preference ordering (benign), but log
    // a warn to match every other registry fault in this file rather than swallowing it.
    logger.warn(`[ModelRegistry] Could not read provider order from models.json: ${err}`);
    return [];
  }
}

/**
 * Pick the first available model whose provider appears earliest in the user's
 * configured provider order; fall back to the first available model when no
 * provider in `providerOrder` is available. Pure — no filesystem access — so it
 * is the single source of truth for "first available" fallback ordering shared
 * by both {@link resolveModel} and the research-model resolver.
 */
export function pickPreferredAvailable<T extends { provider: string }>(
  available: T[],
  providerOrder: string[],
): T | undefined {
  for (const prov of providerOrder) {
    const match = available.find(m => m.provider === prov);
    if (match) return match;
  }
  return available[0];
}
