/**
 * Research Manager
 *
 * Unified entry point for all research tasks.
 * Agnostic of TUI, requires ExtensionContext.
 */

import type { ExtensionContext, AgentToolResult } from '@earendil-works/pi-coding-agent';
import { type Model } from '@earendil-works/pi-ai';
import { DeepResearchOrchestrator } from './deep-research-orchestrator.ts';
import { QuickResearchOrchestrator } from './quick-research-orchestrator.ts';
import { metrics } from '../utils/metrics.ts';
import { getConfig, type Config } from '../config.ts';
import type { ResearchObserver } from './research-observer.ts';

export interface ResearchOptions {
  ctx: ExtensionContext;
  query: string;
  depth?: 0 | 1 | 2 | 3;
  model?: Model<any>;
  observer?: ResearchObserver;
  onUpdate?: (update: AgentToolResult<any>) => void;
  sessionId: string;
  researchId: string;
  config?: Config;
  excludeTools?: string[];
}

/**
 * Run a research task (Quick or Deep)
 */
export async function runResearch(options: ResearchOptions, signal?: AbortSignal): Promise<string> {
  const { ctx, query, depth = 0, model, observer, onUpdate, sessionId, researchId, config, excludeTools } = options;
  const selectedModel = model || ctx.model;

  if (!selectedModel) {
    throw new Error('No model provided for research.');
  }

  const researchStart = Date.now();
  metrics.increment('research_manager_requests_total', 1, { depth: String(depth) });

  const researchConfig = config || getConfig();

  let result: string;
  try {
    if (depth === 0) {
      const orchestrator = new QuickResearchOrchestrator({
        ctx,
        model: selectedModel,
        query,
        sessionId,
        researchId,
        observer,
        onUpdate,
        config: researchConfig,
        excludeTools,
      });
      result = await orchestrator.run(signal);
    } else {
      const orchestrator = new DeepResearchOrchestrator({
        ctx,
        model: selectedModel,
        query,
        complexity: depth as 1 | 2 | 3,
        sessionId,
        researchId,
        observer,
        onUpdate,
        config: researchConfig,
        excludeTools,
      });
      result = await orchestrator.run(signal);
    }
    const researchDuration = Date.now() - researchStart;
    metrics.observe('research_manager_latency_ms', researchDuration, { depth: String(depth), status: 'success' });
    metrics.increment('research_manager_requests_total', 1, { depth: String(depth), status: 'success' });
    return result;
  } catch (error) {
    const researchDuration = Date.now() - researchStart;
    metrics.observe('research_manager_latency_ms', researchDuration, { depth: String(depth), status: 'error' });
    metrics.increment('research_manager_requests_total', 1, { depth: String(depth), status: 'error' });
    throw error;
  }
}
