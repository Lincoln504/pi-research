/**
 * Deep Research Orchestrator
 *
 * Implements the Coordinator-Search-Spawn workflow with:
 * 1. Massive Search: 10-150 queries executed per round before researchers spawn.
 * 2. Concurrency Control: Max 3 parallel researchers, others queued.
 * 3. Real-Time Coordination: Steering messages for link sharing.
 * 4. Multi-Round Execution: Search-Spawn-Evaluate-Delegate cycle.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionContext, AgentSession } from '@mariozechner/pi-coding-agent';
import type { ExtendedAgentSessionEvent } from '../types/extension-context.ts';
import { complete, type Model, type TextContent } from '@mariozechner/pi-ai';
import { parseTokenUsage, calculateTotalTokens } from '../types/llm.ts';
import { logger } from '../logger.ts';
import { 
    ResearchPanelState, 
    addSlice, 
    completeSlice, 
    removeSlice 
} from '../tui/research-panel.ts';
import { createResearcherSession } from './researcher.ts';
import { search } from '../web-research/search.ts';
import { formatLightweightLinkUpdate, registerScrapedLinks, getScrapedLinks } from '../utils/shared-links.ts';
import { extractJson } from '../utils/json-utils.ts';
import { ensureAssistantResponse } from '../utils/text-utils.ts';
import {
    MAX_CONCURRENT_RESEARCHERS,
    MAX_ROUNDS_LEVEL_1,
    MAX_ROUNDS_LEVEL_2,
    MAX_ROUNDS_LEVEL_3,
    AVG_TOKENS_PER_SCRAPE,
    MAX_EVALUATOR_REPORT_LENGTH,
} from '../constants.ts';
import type { SystemResearchState } from './deep-research-types.ts';

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

interface ResearcherConfig {
    id: string;
    name: string;
    goal: string;
    queries: string[];
}

interface ResearchPlan {
    researchers: ResearcherConfig[];
    allQueries: string[];
    action?: 'synthesize' | 'delegate';
    content?: string;
}

export class DeepResearchOrchestrator {
  private activeSessions = new Map<string, AgentSession>();
  private allScrapedLinks: string[] = [];
  private reports = new Map<string, string>();
  private currentRound = 1;
  private siblingTokens = new Map<string, number>();
  private siblingScrapeTokens = new Map<string, number>();

  constructor(private options: DeepResearchOrchestratorOptions) {}

  public async run(signal?: AbortSignal): Promise<string> {
    logger.log(`[Orchestrator] Starting research: "${this.options.query}" (Complexity: ${this.options.complexity})`);

    try {
      // PHASE 1: INITIAL PLANNING
      addSlice(this.options.panelState, 'coord', 'Coordinator: Planning & Initial Search', true);
      this.options.onUpdate();

      const planningPrompt = loadPrompt('system-coordinator')
        .replace('{{query}}', this.options.query);

      const auth = await this.options.ctx.modelRegistry.getApiKeyAndHeaders(this.options.model);
      if (!auth.ok) throw new Error(`Model auth failed: ${auth.error}`);
      
      const planResponse = await complete(this.options.model, {
        messages: [{ role: 'user', content: [{ type: 'text', text: planningPrompt }], timestamp: Date.now() }]
      }, { apiKey: auth.apiKey, headers: auth.headers, signal });
      
      const textContent = planResponse.content.find((c): c is TextContent => c.type === 'text');
      let currentPlan = this.parseJsonPlan(textContent?.text || "");

      const maxRounds = this.options.complexity === 1 ? MAX_ROUNDS_LEVEL_1 :
                        this.options.complexity === 2 ? MAX_ROUNDS_LEVEL_2 :
                        MAX_ROUNDS_LEVEL_3;

      while (this.currentRound <= maxRounds) {
          logger.log(`[Orchestrator] Starting Round ${this.currentRound}...`);

          // PHASE 2: MASSIVE SEARCH BURST (Pre-seed all researchers in round)
          let researcherLinks = new Map<string, string[]>();
          if (currentPlan.allQueries && currentPlan.allQueries.length > 0) {
              const searchResults = await search(currentPlan.allQueries.slice(0, 150), undefined, signal);
              researcherLinks = this.distributeResults(currentPlan, searchResults);
              
              const newLinks = Array.from(new Set(Array.from(researcherLinks.values()).flat()));
              this.allScrapedLinks = Array.from(new Set([...this.allScrapedLinks, ...newLinks]));
              registerScrapedLinks(this.options.panelState.researchId, newLinks);
          }

          completeSlice(this.options.panelState, 'coord');
          this.options.onUpdate();

          // PHASE 3: EXECUTE RESEARCHERS (Concurrency limited to 3)
          await this.runResearchersParallel(currentPlan.researchers, researcherLinks, signal);

          // PHASE 4: EVALUATE & DECIDE
          const evalResult = await this.evaluate(signal);
          
          if (evalResult.action === 'synthesize' || !evalResult.researchers) {
              return evalResult.content || "Research complete.";
          } else {
              // DELEGATE: Transition to new round
              this.currentRound++;
              currentPlan = evalResult;
              addSlice(this.options.panelState, 'coord', `Round ${this.currentRound}: Planning & Search`, true);
              this.options.onUpdate();
          }
      }

      return "Maximum research rounds reached. Synthesizing available findings...";

    } catch (error) {
      logger.error('[Orchestrator] Run failed:', error);
      throw error;
    }
  }

  private parseJsonPlan(text: string): ResearchPlan {
    const result = extractJson<ResearchPlan>(text, 'object');
    if (!result.success || !result.value) {
        throw new Error(`Failed to extract valid JSON plan: ${result.error}`);
    }
    return result.value;
  }

  private distributeResults(plan: ResearchPlan, results: any[]): Map<string, string[]> {
    const linkMap = new Map<string, string[]>();
    plan.researchers.forEach((r) => {
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

  /**
   * Manages concurrent execution of researchers.
   * Ensures exactly MAX_CONCURRENT_RESEARCHERS (3) run at a time.
   */
  private async runResearchersParallel(configs: ResearcherConfig[], linksMap: Map<string, string[]>, signal?: AbortSignal) {
      const queue = [...configs];
      const active = new Set<Promise<void>>();

      while (queue.length > 0 || active.size > 0) {
          if (signal?.aborted) throw new Error("Research aborted.");

          // Fill active slots
          while (active.size < MAX_CONCURRENT_RESEARCHERS && queue.length > 0) {
              const config = queue.shift()!;
              const links = linksMap.get(config.id) || [];
              const p = this.runResearcher(config, links).finally(() => { active.delete(p); });
              active.add(p);
          }

          // Wait for at least one to finish before spawning next
          if (active.size > 0) await Promise.race(active);
      }
  }

  private async runResearcher(config: ResearcherConfig, initialLinks: string[]): Promise<void> {
    const label = `researcher.${config.id}`;
    addSlice(this.options.panelState, label, `Researcher: ${config.name}`, true);
    this.options.onUpdate();

    try {
        const systemPromptTemplate = loadPrompt('researcher');
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
            onLinksScraped: (links) => this.broadcastLinks(config.id, config.name, links),
            getGlobalState: () => ({
                researchId: this.options.panelState.researchId,
                rootQuery: this.options.query,
                allScrapedLinks: getScrapedLinks(this.options.panelState.researchId),
            } as SystemResearchState),
            updateGlobalLinks: (links) => registerScrapedLinks(this.options.panelState.researchId, links),
            getTokensUsed: () => this.siblingTokens.get(config.id) ?? 0,
            getScrapeTokens: () => this.siblingScrapeTokens.get(config.id) ?? 0,
            contextWindowSize: (this.options.model as any)?.contextWindow ?? 200000,
        });

        const subscription = session.subscribe((event: ExtendedAgentSessionEvent) => {
            if (event.type === 'message_end' && event.message?.role === 'assistant') {
                const usage = parseTokenUsage(event.message?.usage);
                const tokens = calculateTotalTokens(usage);
                if (tokens > 0) {
                    const currentTokens = this.siblingTokens.get(config.id) ?? 0;
                    this.siblingTokens.set(config.id, currentTokens + tokens);
                    this.options.onTokens(tokens);

                    // Estimate scrape tokens
                    const scrapeTokenEstimate = (event.message as any)?.toolResults?.reduce((sum: number, result: any) => {
                        if (result.toolName === 'scrape') {
                            return sum + ((result.details?.count ?? 0) * AVG_TOKENS_PER_SCRAPE);
                        }
                        return sum;
                    }, 0) || 0;
                    
                    if (scrapeTokenEstimate > 0) {
                        const currentScrapeTokens = this.siblingScrapeTokens.get(config.id) ?? 0;
                        this.siblingScrapeTokens.set(config.id, currentScrapeTokens + scrapeTokenEstimate);
                    }
                }
            }
        });

        this.activeSessions.set(config.id, session);
        await session.prompt("Begin your specialized research.");
        
        if (typeof subscription === 'function') subscription();
        
        const report = ensureAssistantResponse(session, `Researcher ${config.id}`);
        this.reports.set(config.id, report);
        await this.injectCompletionSummary(config.id, config.name, report);

        completeSlice(this.options.panelState, label);
        this.activeSessions.delete(config.id);
    } catch (e) {
        removeSlice(this.options.panelState, label);
        this.activeSessions.delete(config.id);
        throw e;
    }
  }

  private broadcastLinks(sourceId: string, sourceName: string, links: string[]) {
      const updateMsg = formatLightweightLinkUpdate(links, sourceId, sourceName);
      for (const [id, session] of this.activeSessions) {
          if (id !== sourceId) session.steer(updateMsg).catch(() => {});
      }
      this.allScrapedLinks = Array.from(new Set([...this.allScrapedLinks, ...links]));
      registerScrapedLinks(this.options.panelState.researchId, links);
  }

  private async injectCompletionSummary(sourceId: string, sourceName: string, fullReport: string) {
      const summary = this.extractSummary(fullReport);
      const urls = this.extractUrls(fullReport);
      const msg = `## Sibling ${sourceId} (${sourceName}) Completed\n\n### Summary\n${summary}\n\n### URLs\n${urls.map(u => `- ${u}`).join('\n')}\n\n> Adjust your direction.`;

      for (const [id, session] of this.activeSessions) {
          if (id !== sourceId) session.steer(msg).catch(() => {});
      }
  }

  private async evaluate(signal?: AbortSignal): Promise<ResearchPlan> {
      addSlice(this.options.panelState, 'eval', 'Lead Evaluator: Assessing Findings', true);
      this.options.onUpdate();

      const evalPrompt = loadPrompt('system-lead-evaluator')
          .replace('{ROOT_QUERY}', this.options.query)
          .replace('{ROUND_NUMBER}', this.currentRound.toString())
          .replace('{MAX_ROUNDS}', ((this.options.complexity === 1 ? MAX_ROUNDS_LEVEL_1 : this.options.complexity === 2 ? MAX_ROUNDS_LEVEL_2 : MAX_ROUNDS_LEVEL_3)).toString());

      const reportsText = Array.from(this.reports.entries())
          .map(([id, report]) => {
              const truncated = report.length > MAX_EVALUATOR_REPORT_LENGTH
                  ? report.slice(0, MAX_EVALUATOR_REPORT_LENGTH) + '\n\n[Report truncated]'
                  : report;
              return `### Researcher ${id} Report\n\n${truncated}`;
          })
          .join('\n\n---\n\n');

      const auth = await this.options.ctx.modelRegistry.getApiKeyAndHeaders(this.options.model);
      if (!auth.ok) throw new Error(`Model auth failed: ${auth.error}`);

      const response = await complete(this.options.model, {
          messages: [
              {
                  role: 'user',
                  content: [{ type: 'text', text: `Findings so far:\n\n${reportsText}\n\n---\n\n${evalPrompt}` }],
                  timestamp: Date.now(),
              },
          ]
      }, { apiKey: auth.apiKey, headers: auth.headers, signal });

      const textContent = response.content.find((c): c is TextContent => c.type === 'text');
      const text = textContent?.text || "";
      completeSlice(this.options.panelState, 'eval');
      this.options.onUpdate();

      const extracted = extractJson<ResearchPlan>(text, 'any');
      if (extracted.success && extracted.value) {
          return extracted.value;
      } else {
          return { action: 'synthesize', content: text, researchers: [], allQueries: [] };
      }
  }

  private extractSummary(report: string): string {
      const match = report.match(/###\s*Executive\s*Summary\s*\n([\s\S]*?)(?=\n###|$)/i);
      if (match) return match[1]!.trim().split('.').slice(0, 4).join('.') + '.';
      return report.split('.').slice(0, 3).join('.') + '.';
  }

  private extractUrls(report: string): string[] {
      const matches = report.matchAll(/https?:\/\/[^\s)\]>"]+/g);
      return Array.from(new Set(Array.from(matches).map(m => m[0])));
  }
}
