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
import { pickPreferredAvailable, readModelsJsonProviderOrder } from './model-registry-factory.ts';

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
    modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`)
  );
  const matchById = (id: string): Model<any> | undefined => {
    // Exact "provider/id" wins outright; otherwise prefer an authed same-id entry.
    const exact = modelRegistry.getAll().find((m) => `${m.provider}/${m.id}` === id);
    if (exact) return exact as Model<any>;
    const sameId = modelRegistry.getAll().filter((m) => m.id === id) as Model<any>[];
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
  const available = modelRegistry.getAvailable();
  if (available.length > 0) {
    return pickPreferredAvailable(available, readModelsJsonProviderOrder()) as Model<any>;
  }

  throw new Error('No LLM model available for research. Please configure your model registry (~/.pi/agent/models.json).');
}
