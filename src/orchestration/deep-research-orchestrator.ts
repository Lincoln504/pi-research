/**
 * Deep Research Orchestrator
 *
 * Implements the Coordinator-Search-Spawn workflow.
 * 1. Coordinator plans all researchers and 10-150 initial queries.
 * 2. Orchestrator executes massive search burst.
 * 3. Researchers spawn with pre-seeded links and perform one massive search of their own.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function loadPrompt(name: string): string {
  try {
    const promptPath = join(__dirname, '..', 'prompts', `${name}.md`);
    return readFileSync(promptPath, 'utf-8');
  } catch (err) {
    logger.error(`[Orchestrator] Failed to load prompt: ${name}`, err);
    return '';
  }
}

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

      const planningPrompt = loadPrompt('system-coordinator')
        .replace('{{query}}', this.options.query)
        .replace('{{maxResearchers}}', (this.options.complexity * 2).toString());

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
      return "Research completed. Detailed reports available in session history.";

    } catch (error) {
      logger.error('[Orchestrator] Run failed:', error);
      throw error;
    }
  }

  private parseCoordinatorPlan(text: string): any {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("Coordinator failed to provide a valid JSON plan.");
    try {
        return JSON.parse(jsonMatch[0]);
    } catch (e) {
        logger.error("[Orchestrator] JSON Parse Failed. Content:", jsonMatch[0]);
        throw e;
    }
  }

  private distributeResults(plan: any, results: any[]): Map<string, string[]> {
    const linkMap = new Map<string, string[]>();
    
    plan.researchers.forEach((r: any) => {
        const ownedLinks: string[] = [];
        const rQueries = r.queries.map((q: string) => q.toLowerCase().trim());
        
        results.forEach((res: any) => {
            const resQuery = res.query.toLowerCase().trim();
            if (rQueries.some((rq: string) => resQuery.includes(rq))) {
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
        const systemPromptTemplate = loadPrompt('researcher');
        
        // CONDITIONAL PRE-SEEDING: Only include links section if links are actually provided
        const linksSection = initialLinks.length > 0 
            ? `## Your Starting Evidence\nYou have been pre-seeded with the following high-priority links to investigate:\n${initialLinks.join('\n')}`
            : '';

        const systemPrompt = systemPromptTemplate
            .replace('{{goal}}', config.goal)
            .replace('{{evidence_section}}', linksSection);

        const session = await createResearcherSession({
            cwd: this.options.ctx.cwd,
            ctxModel: this.options.model,
            modelRegistry: this.options.ctx.modelRegistry,
            settingsManager: (this.options.ctx as any).settingsManager,
            systemPrompt,
            extensionCtx: this.options.ctx,
        });

        await session.prompt("Begin your specialized research based on the provided links and one optional massive search call.");
        
        completeSlice(this.options.panelState, label);
        return "Researcher completed.";
    } catch (e) {
        removeSlice(this.options.panelState, label);
        throw e;
    }
  }
}
