/**
 * Research Model Resolver
 * 
 * Centralized logic for resolving the research model based on 
 * explicit parameters, configuration, and host context.
 */

import { type Model } from '@earendil-works/pi-ai';
import { type ModelRegistry } from '@earendil-works/pi-coding-agent';
import { getConfig } from '../../config.ts';
import { logger } from '../../logger.ts';
import { buildNoModelAvailableMessage, pickPreferredAvailable, readModelsJsonProviderOrder, safeGetAll, safeGetAvailable } from './model-registry-factory.ts';

/**
 * Resolve the research model with standardized priority:
 * 1. Explicit modelId parameter (highest priority)
 * 2. RESEARCH_MODEL from configuration
 * 3. Host model from context (fallback)
 * 
 * @param options - Resolution context
 * @returns The resolved model
 */
export function resolveResearchModel(options: {
  modelRegistry: ModelRegistry;
  config?: import('../../config.ts').Config;
  modelId?: string;
  hostModel?: Model<any>;
  cwd?: string;
}): Model<any> {
  const { modelRegistry, config, modelId, hostModel, cwd } = options;
  const activeConfig = config || getConfig(cwd);

  // The same model id can be registered under multiple providers — typically a
  // user-configured authed provider plus pi's built-in unauthed one (e.g.
  // `glm-coding/glm-4.7` vs `zai/glm-4.7`). When matching by bare id, prefer a
  // provider that actually has auth so we never resolve to a keyless entry that
  // throws "No API key for provider" at the first LLM call.
  const authedKeys = new Set(
    safeGetAvailable(modelRegistry).map((m) => `${m.provider}/${m.id}`)
  );
  const matchById = (id: string): Model<any> | undefined => {
    // Exact "provider/id" wins outright; otherwise prefer an authed same-id entry.
    const allModels = safeGetAll(modelRegistry);
    const exact = allModels.find((m) => `${m.provider}/${m.id}` === id);
    if (exact) return exact as Model<any>;
    const sameId = allModels.filter((m) => m.id === id) as Model<any>[];
    return sameId.find((m) => authedKeys.has(`${m.provider}/${m.id}`)) ?? sameId[0];
  };

  // 1. Explicit parameter (e.g. from tool call)
  if (modelId) {
    const found = matchById(modelId);
    if (found) {
      return found as Model<any>;
    }
    logger.warn(`[ModelResolver] Explicit model '${modelId}' not found in registry; falling back.`);
  }

  // 2. RESEARCH_MODEL override from configuration
  if (activeConfig.RESEARCH_MODEL) {
    const target = activeConfig.RESEARCH_MODEL;
    const found = matchById(target);
    if (found) {
      return found as Model<any>;
    }
    logger.warn(`[ModelResolver] RESEARCH_MODEL '${target}' not found in registry; falling back.`);
  }

  // 3. Host model fallback
  if (hostModel) {
    return hostModel;
  }

  // 4. Absolute fallback: pick first available model with auth, honoring the
  //    user's models.json provider order (consistent with resolveModel step 3 —
  //    otherwise the host model and the research fallback could disagree on which
  //    of several authed providers to prefer).
  const available = safeGetAvailable(modelRegistry);
  if (available.length > 0) {
    return pickPreferredAvailable(available, readModelsJsonProviderOrder()) as Model<any>;
  }

  // 5. Last resort before failing: any known model at all (host may not expose
  //    getAvailable(), so an empty "available" set is not proof of "no models").
  const anyModel = safeGetAll(modelRegistry);
  if (anyModel.length > 0) {
    return pickPreferredAvailable(anyModel, readModelsJsonProviderOrder()) as Model<any>;
  }

  throw new Error(buildNoModelAvailableMessage());
}

/**
 * Best-effort, CONSERVATIVE signal for "will pi-ai apply prompt caching for
 * this resolved model." pi-ai owns all cache-mechanism logic internally (this
 * codebase never constructs cache_control blocks itself) and exposes no
 * public API to ask in advance for most providers, so this can only answer
 * for the two client-visible cases:
 *
 * - `api === 'anthropic-messages'`: caching is native and on by default (no
 *   capability gate at all — see pi-ai's anthropic-messages provider).
 * - `api === 'openai-completions'` with `compat.cacheControlFormat ===
 *   'anthropic'`: an explicit opt-in to Anthropic-style cache_control
 *   emulation (e.g. an OpenRouter/gateway route to an Anthropic model
 *   configured with this override).
 *
 * Every other case returns false even though caching may actually be
 * active: pi's generated model catalog sets `cacheControlFormat` on zero
 * models, so plain `openai-completions` traffic (this project's custom
 * providers — glm-coding, cerebras, zai, OpenRouter, ...) has its cache
 * compat auto-detected by pi-ai's own private, unexported heuristic INSIDE
 * the live request — not knowable client-side, before or after model
 * resolution. Providers with fully implicit/automatic caching
 * (openai-responses family, google-generative-ai, google-vertex,
 * mistral-conversations, bedrock-converse-stream) have no "will it be
 * active" signal at all — it depends on provider-side runtime behavior
 * (minimum prompt length, server cache state). Treat this as "caching is
 * DEFINITELY active" — a false negative is expected and fine for providers
 * outside these two cases, but a false positive would be a real bug.
 */
export function isPromptCachingActiveForModel(model: Model<any> | undefined): boolean {
  if (!model) return false;
  if (model.api === 'anthropic-messages') return true;
  if (model.api === 'openai-completions') {
    const compat = model.compat as { cacheControlFormat?: string } | undefined;
    return compat?.cacheControlFormat === 'anthropic';
  }
  return false;
}
