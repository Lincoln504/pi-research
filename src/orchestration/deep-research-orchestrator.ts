/**
 * Deep Research Orchestrator
 *
 * Implements the Coordinator-Search-Spawn workflow with:
 * 1. Handshake Elimination: Initial links injected into system prompt.
 * 2. Real-Time Steering: New links broadcast to siblings immediately.
 * 3. Minimal Sibling Injection: Summaries instead of full reports.
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
import { formatLightweightLinkUpdate } from '../utils/shared-links.ts';

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
  private activeSessions = new Map<string, any>();
  private allScrapedLinks: string[] = [];

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
      }, { apiKey: auth.apiKey, headers: auth.headers, signal });
      
      const textContent = planResponse.content.find((c: any) => c.type === 'text') as any;
      const plan = this.parseCoordinatorPlan(textContent?.text || "");

      logger.log(`[Orchestrator] Plan received: ${plan.researchers.length} researchers.`);

      // PHASE 2: MASSIVE INITIAL SEARCH
      let researcherLinks = new Map<string, string[]>();
      if (plan.allQueries.length > 0) {
          const searchResults = await search(plan.allQueries.slice(0, 150), undefined, signal);
          researcherLinks = this.distributeResults(plan, searchResults);
          
          // Seed global pool with initial search results
          const initialLinks = Array.from(new Set(Array.from(researcherLinks.values()).flat()));
          this.allScrapedLinks = [...initialLinks];
      }

      completeSlice(this.options.panelState, 'coord');
      this.options.onUpdate();

      // PHASE 3: SPAWN RESEARCHERS
      const researcherPromises = plan.researchers.map(async (r: any) => {
          const links = researcherLinks.get(r.id) || [];
          return this.runResearcher(r, links);
      });

      await Promise.all(researcherPromises);
      
      return "Research completed. Detailed reports available in session history.";

    } catch (error) {
      logger.error('[Orchestrator] Run failed:', error);
      throw error;
    }
  }

  private parseCoordinatorPlan(text: string): any {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("Coordinator failed to provide a valid JSON plan.");
    return JSON.parse(jsonMatch[0]);
  }

  private distributeResults(plan: any, results: any[]): Map<string, string[]> {
    const linkMap = new Map<string, string[]>();
    plan.researchers.forEach((r: any) => {
        const ownedLinks: string[] = [];
        const rQueries = r.queries.map((q: string) => q.toLowerCase().trim());
        results.forEach((res: any) => {
            if (rQueries.some((rq: string) => res.query.toLowerCase().includes(rq))) {
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
        
        // HANDSHAKE ELIMINATION: Inject all currently known links
        const linksSection = initialLinks.length > 0 
            ? `## Your Starting Evidence\nYou have been pre-seeded with these high-priority links:\n${initialLinks.join('\n')}`
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
            onLinksScraped: (links) => this.broadcastLinks(config.id, config.name, links)
        });

        this.activeSessions.set(config.id, session);

        await session.prompt("Begin your specialized research.");
        
        const report = await this.extractFinalReport(session);
        await this.injectCompletionSummary(config.id, config.name, report);

        completeSlice(this.options.panelState, label);
        this.activeSessions.delete(config.id);
        return "Researcher completed.";
    } catch (e) {
        removeSlice(this.options.panelState, label);
        this.activeSessions.delete(config.id);
        throw e;
    }
  }

  private broadcastLinks(sourceId: string, sourceName: string, links: string[]) {
      const updateMsg = formatLightweightLinkUpdate(links, sourceId, sourceName);
      for (const [id, session] of this.activeSessions) {
          if (id !== sourceId) {
              session.steer(updateMsg).catch(() => {});
          }
      }
      this.allScrapedLinks = Array.from(new Set([...this.allScrapedLinks, ...links]));
  }

  private async injectCompletionSummary(sourceId: string, sourceName: string, fullReport: string) {
      // MINIMAL SIBLING INJECTION: 3-5 sentence summary + URLs
      const summary = this.extractSummary(fullReport);
      const urls = this.extractUrls(fullReport);
      
      const msg = `## Sibling ${sourceId} (${sourceName}) Completed\n\n` +
                  `### Summary of Findings\n${summary}\n\n` +
                  `### URLs Scraped\n${urls.length > 0 ? urls.map(u => `- ${u}`).join('\n') : '(none)'}\n\n` +
                  `> Adjust your direction to avoid duplication.`;

      for (const [id, session] of this.activeSessions) {
          if (id !== sourceId) {
              session.steer(msg).catch(() => {});
          }
      }
  }

  private extractSummary(report: string): string {
      const match = report.match(/###\s*Executive\s*Summary\s*\n([\s\S]*?)(?=\n###|$)/i);
      if (match) return match[1]!.trim().split('.').slice(0, 4).join('.') + '.';
      return report.split('.').slice(0, 3).join('.') + '.';
  }

  private extractUrls(report: string): string[] {
      const matches = report.matchAll(/https?:\/\/[^\s\)\]>"]+/g);
      return Array.from(new Set(Array.from(matches).map(m => m[0])));
  }

  private async extractFinalReport(session: any): Promise<string> {
      const state = session.state;
      const last = state.messages[state.messages.length - 1];
      if (last?.role === 'assistant' && Array.isArray(last.content)) {
          return last.content.find((c: any) => c.type === 'text')?.text || "";
      }
      return "";
  }
}
