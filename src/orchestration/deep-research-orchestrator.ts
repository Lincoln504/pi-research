/**
 * Deep Research Orchestrator
 *
 * Implements the Coordinator-Search-Spawn workflow.
 * 1. Coordinator plans all researchers and 10-150 initial queries.
 * 2. Orchestrator executes massive search burst.
 * 3. Researchers spawn with pre-seeded links and perform one massive search of their own.
 */

import type { ExtensionContext } from '@mariozechner/pi-coding-agent';
import { complete, type Model } from '@mariozechner/pi-ai';
import { logger } from '../logger.ts';
import { 
    ResearchPanelState, 
    addSlice, 
    completeSlice, 
    removeSlice 
} from '../tui/research-panel.ts';
import { createResearcherSession } from './researcher.ts';
import { search } from '../web-research/search.ts';

export interface DeepResearchOrchestratorOptions {
  ctx: ExtensionContext;
  model: Model<any>;
  query: string;
  complexity: 1 | 2 | 3;
  onTokens: (n: number) => void;
  onUpdate: () => void;
  panelState: ResearchPanelState;
}

export class DeepResearchOrchestrator {
  constructor(private options: DeepResearchOrchestratorOptions) {}

  public async run(signal?: AbortSignal): Promise<string> {
    logger.log(`[Orchestrator] Starting research: "${this.options.query}" (Complexity: ${this.options.complexity})`);

    try {
      // PHASE 1: COORDINATOR PLANNING
      addSlice(this.options.panelState, 'coord', 'Coordinator: Planning & Initial Search', true);
      this.options.onUpdate();

      const planningPrompt = this.buildPlanningPrompt();
      const auth = await this.options.ctx.modelRegistry.getApiKeyAndHeaders(this.options.model);
      if (!auth.ok) throw new Error(`Model auth failed: ${auth.error}`);
      
      const planResponse = await complete(this.options.model, {
        messages: [{ role: 'user', content: [{ type: 'text', text: planningPrompt }], timestamp: Date.now() }]
      }, {
        apiKey: auth.apiKey,
        headers: auth.headers,
        signal
      });
      
      const textContent = planResponse.content.find((c: any) => c.type === 'text') as any;
      const plan = this.parseCoordinatorPlan(textContent?.text || "");

      logger.log(`[Orchestrator] Plan received: ${plan.researchers.length} researchers, ${plan.allQueries.length} total queries.`);

      // PHASE 2: MASSIVE INITIAL SEARCH
      let researcherLinks = new Map<string, string[]>();
      if (plan.allQueries.length > 0) {
          // Flatten all queries (up to 150)
          const searchResults = await search(plan.allQueries.slice(0, 150), undefined, signal);
          researcherLinks = this.distributeResults(plan, searchResults);
      }

      completeSlice(this.options.panelState, 'coord');
      this.options.onUpdate();

      // PHASE 3: SPAWN RESEARCHERS
      const researcherPromises = plan.researchers.map(async (r: any) => {
          const links = researcherLinks.get(r.id) || [];
          return this.runResearcher(r, links);
      });

      await Promise.all(researcherPromises);
      
      // PHASE 4: SYNTHESIS
      // The individual researchers have completed their work.
      return "Research completed. See individual reports.";

    } catch (error) {
      logger.error('[Orchestrator] Run failed:', error);
      throw error;
    }
  }

  private buildPlanningPrompt(): string {
      return `You are the Lead Research Coordinator. 
Your goal is to research: "${this.options.query}"

Plan a team of up to ${this.options.complexity * 2} specialized researchers.
For each researcher, provide:
1. A unique ID.
2. A specialized goal.
3. A list of 5-15 highly specific search queries.

Output your plan as a JSON block:
{
  "researchers": [{ "id": "r1", "name": "...", "goal": "...", "queries": ["...", "..."] }],
  "allQueries": ["flat", "list", "of", "all", "queries"]
}`;
  }

  private parseCoordinatorPlan(text: string): any {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("Coordinator failed to provide a valid JSON plan.");
    return JSON.parse(jsonMatch[0]);
  }

  private distributeResults(plan: any, results: any[]): Map<string, string[]> {
    const linkMap = new Map<string, string[]>();
    
    // Simple distribution based on query ownership
    plan.researchers.forEach((r: any) => {
        const ownedLinks: string[] = [];
        r.queries.forEach((q: string) => {
            const res = results.find(rs => rs.query === q);
            if (res) {
                res.results.forEach((item: any) => ownedLinks.push(item.url));
            }
        });
        linkMap.set(r.id, Array.from(new Set(ownedLinks)));
    });
    
    return linkMap;
  }

  private async runResearcher(config: any, initialLinks: string[]): Promise<string> {
    const label = `researcher.${config.id}`;
    addSlice(this.options.panelState, label, `Researcher: ${config.name}`, true);
    this.options.onUpdate();

    try {
        const session = await createResearcherSession({
            cwd: this.options.ctx.cwd,
            ctxModel: this.options.model,
            modelRegistry: this.options.ctx.modelRegistry,
            settingsManager: (this.options.ctx as any).settingsManager,
            systemPrompt: this.buildResearcherPrompt(config, initialLinks),
            extensionCtx: this.options.ctx,
        });

        await session.prompt("Begin your specialized research based on the provided links and one optional massive search call.");
        
        // Extract final response from session state if needed.
        const state = (session as any).state;
        const lastMsg = state?.messages ? state.messages[state.messages.length - 1] : null;
        let finalResponse = "Research completed.";
        if (lastMsg?.role === 'assistant' && Array.isArray(lastMsg.content)) {
            const textContent = lastMsg.content.find((c: any) => c.type === 'text');
            if (textContent?.text) finalResponse = textContent.text;
        }

        completeSlice(this.options.panelState, label);
        return finalResponse;
    } catch (e) {
        removeSlice(this.options.panelState, label);
        throw e;
    }
  }

  private buildResearcherPrompt(config: any, links: string[]): string {
      return `You are a specialized researcher. 
Goal: ${config.goal}

You have been pre-seeded with the following links to investigate:
${links.join('\n')}

GUIDELINES:
1. Analyze the provided links first.
2. You may use the 'search' tool EXACTLY ONCE to find more information if needed.
3. Your search call must contain 10-150 queries to be effective.
4. Focus on deep analysis and extraction of evidence.`;
  }
}
