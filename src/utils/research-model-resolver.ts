/**
 * Research Model Resolver
 * 
 * Centralized logic for resolving the research model based on 
 * explicit parameters, configuration, and host context.
 */

import { type Model } from '@earendil-works/pi-ai';
import { type ModelRegistry } from '@earendil-works/pi-coding-agent';
import { getConfig } from '../config.ts';
import { logger } from '../logger.ts';

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
  config?: import('../config.ts').Config;
  modelId?: string;
  hostModel?: Model<any>;
  cwd?: string;
}): Model<any> {
  const { modelRegistry, config, modelId, hostModel, cwd } = options;
  const activeConfig = config || getConfig(cwd);

  // 1. Explicit parameter (e.g. from tool call)
  if (modelId) {
    const found = modelRegistry.getAll().find((m) => m.id === modelId);
    if (found) {
      return found as Model<any>;
    }
    logger.warn(`[ModelResolver] Explicit model '${modelId}' not found in registry; falling back.`);
  }

  // 2. RESEARCH_MODEL override from configuration
  if (activeConfig.RESEARCH_MODEL) {
    const target = activeConfig.RESEARCH_MODEL;
    const found = modelRegistry.getAll().find(
      (m) => `${m.provider}/${m.id}` === target || m.id === target
    );
    if (found) {
      return found as Model<any>;
    }
    logger.warn(`[ModelResolver] RESEARCH_MODEL '${target}' not found in registry; falling back.`);
  }

  // 3. Host model fallback
  if (hostModel) {
    return hostModel;
  }

  // 4. Absolute fallback: pick first available model with auth
  const available = modelRegistry.getAvailable();
  if (available.length > 0) return available[0] as Model<any>;

  throw new Error('No LLM model available for research. Please configure your model registry (~/.pi/agent/models.json).');
}
