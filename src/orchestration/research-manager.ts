/**
 * Research Manager
 *
 * Unified entry point for all research tasks.
 * Agnostic of TUI, requires ExtensionContext.
 */

import type { ExtensionContext } from '@mariozechner/pi-coding-agent';
import { type Model } from '@mariozechner/pi-ai';
import { QuickResearchOrchestrator } from './quick-research-orchestrator.ts';
import { DeepResearchOrchestrator } from './deep-research-orchestrator.ts';
import type { ResearchObserver } from './research-observer.ts';
import type { Config } from '../config.ts';

export interface ResearchOptions {
  ctx: ExtensionContext;
  query: string;
  depth?: 0 | 1 | 2 | 3;
  model?: Model<any>;
  observer?: ResearchObserver;
  sessionId: string;
  researchId: string;
  config?: Config;
}

/**
 * Run a research task (Quick or Deep)
 */
export async function runResearch(options: ResearchOptions, signal?: AbortSignal): Promise<string> {
  const { ctx, query, depth = 0, model, observer, sessionId, researchId, config } = options;
  const selectedModel = model || ctx.model;

  if (!selectedModel) {
    throw new Error('No model provided for research.');
  }

  if (depth === 0) {
    const orchestrator = new QuickResearchOrchestrator({
      ctx,
      model: selectedModel,
      query,
      sessionId,
      researchId,
      observer,
      config,
    });
    return orchestrator.run(signal);
  } else {
    const orchestrator = new DeepResearchOrchestrator({
      ctx,
      model: selectedModel,
      query,
      complexity: depth as 1 | 2 | 3,
      sessionId,
      researchId,
      observer,
      config,
    });
    return orchestrator.run(signal);
  }
}
