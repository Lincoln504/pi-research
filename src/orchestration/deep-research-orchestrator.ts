/**
 * Deep Research Orchestrator
 *
 * Implements the Coordinator-Search-Spawn workflow with:
 * 1. Coordinated Search Burst: Seeds all researchers with links before they start.
 * 2. Concurrency Control: Max 3 parallel researchers, others queued.
 * 3. Real-Time Coordination: Steering messages for link sharing.
 * 4. Multi-Round Execution: Search-Spawn-Evaluate-Delegate cycle.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { injectCurrentDate } from '../utils/inject-date.ts';
import { 
    convertToLlm,
    buildSessionContext,
    type ExtensionContext, 
    type AgentSession, 
    type AgentSessionEvent 
} from '@mariozechner/pi-coding-agent';
import { complete, completeSimple, type Model, type TextContent, type Usage } from '@mariozechner/pi-ai';
import { calculateTotalTokens, isTextContentBlock } from '../types/llm.ts';
import { logger } from '../logger.ts';
import { getConfig } from '../config.ts';
import type { ResearchPanelState } from '../tui/research-panel.ts';
import { 
    addSlice, 
    activateSlice,
    completeSlice, 
    removeSlice,
    updateSliceTokens,
    updateSliceStatus,
} from '../tui/research-panel.ts';
import { createResearcherSession } from './researcher.ts';
import { search } from '../web-research/search.ts';
import { formatLightweightLinkUpdate, registerScrapedLinks, getScrapedLinks } from '../utils/shared-links.ts';
import { extractJson } from '../utils/json-utils.ts';
import { ensureAssistantResponse } from '../utils/text-utils.ts';
import {
    MAX_CONCURRENT_RESEARCHERS,
    MAX_TEAM_SIZE_LEVEL_1,
    MAX_TEAM_SIZE_LEVEL_2,
    MAX_TEAM_SIZE_LEVEL_3,
    MAX_ROUNDS_LEVEL_1,
    MAX_ROUNDS_LEVEL_2,
    MAX_ROUNDS_LEVEL_3,
    MAX_QUERIES_PER_RESEARCHER_LEVEL_1,
    MAX_QUERIES_PER_RESEARCHER_LEVEL_2,
    MAX_QUERIES_PER_RESEARCHER_LEVEL_3,
    AVG_TOKENS_PER_SCRAPE,
    MAX_EXTRA_ROUNDS,
    RESEARCHER_LAUNCH_DELAY_MS,
    MAX_GATHERING_CALLS,
    MAX_SCRAPE_CALLS,
} from '../constants.ts';

const STREAMING_UPDATE_THRESHOLD_CHARS = 100;
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

// Max tool calls per researcher (for fractional progress within a researcher's run)
const RESEARCHER_TOOL_BUDGET = MAX_GATHERING_CALLS + MAX_SCRAPE_CALLS;

export class DeepResearchOrchestrator {
  private activeSessions = new Map<string, AgentSession>();
  private allScrapedLinks: string[] = [];
  private allSearchedQueries: string[] = [];
  private reports = new Map<string, string>();
  private currentRound = 1;
  private siblingTokens = new Map<string, number>();
  private siblingScrapeTokens = new Map<string, number>();
  private progressCredits = new Map<string, number>();
  private runStartMs = Date.now();

  private static readonly UNITS_PER_RESEARCHER = 1;
  private static readonly LEAD_EVAL_UNITS = 1;

  constructor(private options: DeepResearchOrchestratorOptions) {}

  private elapsed(): string {
    const ms = Date.now() - this.runStartMs;
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    return m > 0 ? `+${m}m${s % 60}s` : `+${s}s`;
  }

  public async run(signal?: AbortSignal): Promise<string> {
    this.runStartMs = Date.now();
    logger.log(`[Orchestrator] ${this.elapsed()} Starting research: "${this.options.query}" (Complexity: ${this.options.complexity})`);

    try {
      // PHASE 1: INITIAL PLANNING
      const coordStartMs = Date.now();
      addSlice(this.options.panelState, 'coord', 'coord', true);
      activateSlice(this.options.panelState, 'coord');
      updateSliceStatus(this.options.panelState, 'coord', 'Planning...');
      this.options.onUpdate();

      const complexityLabel = this.options.complexity === 1 ? 'Level 1 — Normal'
          : this.options.complexity === 2 ? 'Level 2 — Deep'
          : 'Level 3 — Ultra (exhaustive)';

      const complexityGuidance = this.options.complexity === 3
          ? `**Ultra mode**: This is a comprehensive, exhaustive research effort. Plan ALL ${this.getTeamSize()} researcher slots. Each researcher should use the FULL query budget of ${this.getQueryBudget()} queries. Coverage must be thorough — no sub-topic should be left unresearched.`
          : this.options.complexity === 2
          ? `**Deep mode**: Plan enough researchers to cover all major angles (up to ${this.getTeamSize()}). Use a substantial portion of the query budget for each.`
          : `**Normal mode**: Plan ${this.getTeamSize()} researchers covering the most important angles.`;

      // Add local codebase context to coordinator planning if query references local code
      let localContextSection = '';
      const queryLower = this.options.query.toLowerCase();
      const isCodeResearch = queryLower.includes('codebase') || queryLower.includes('code') || 
                           queryLower.includes('project') || queryLower.includes('this') ||
                           queryLower.includes('implementation') || queryLower.includes('architecture');
      
      if (isCodeResearch) {
          try {
              const { grep } = await import('../tools/grep.ts');
              // Search for key terms from query in local codebase
              const searchTerms = this.options.query.split(/\s+/).filter((w, i, arr) => 
                  w.length > 3 && arr.indexOf(w) === i  // unique words > 3 chars
              ).slice(0, 3);  // Limit to first 3 terms
              
              if (searchTerms.length > 0) {
                  localContextSection = '\n\n## Local Codebase Context\n\nFound matches for: ' + searchTerms.join(', ') + '\n\n';
                  for (const term of searchTerms) {
                      try {
                          const result = await grep(term, this.options.ctx.cwd);
                          localContextSection += `\n### Matches for "${term}"\n\n${result.slice(0, 10000)}\n\n...[truncated]\n\n`;
                      } catch (_e) {
                          // Grep failed, skip this term
                      }
                  }
              }
          } catch (e) {
              // Grep tool not available or failed, continue without local context
              logger.debug('[Orchestrator] Could not add local context to coordinator:', e);
          }
      }

      const basePlanningPrompt = loadPrompt('system-coordinator')
        .replace('{{query}}', this.options.query)
        .replace('{COMPLEXITY_LABEL}', complexityLabel)
        .replace('{MAX_TEAM_SIZE}', this.getTeamSize().toString())
        .replace('{QUERY_BUDGET}', this.getQueryBudget().toString())
        .replace('{COMPLEXITY_GUIDANCE}', complexityGuidance);

      const auth = await this.options.ctx.modelRegistry.getApiKeyAndHeaders(this.options.model);
      if (!auth.ok) throw new Error(`Model auth failed: ${auth.error}`);

      let currentPlan: ResearchPlan | undefined;
      for (let attempt = 1; attempt <= 2; attempt++) {
        const retryHint = attempt > 1
          ? '\n\nCRITICAL: Your previous response could not be parsed as JSON. Return ONLY the raw JSON object — no markdown, no explanation, no code fences.'
          : '';
        
        // BRANCHING: Coordinator sees the full parent conversation history
        const history = this.options.ctx.sessionManager.getBranch();
        const sessionContext = buildSessionContext(history);
        const historyMessages = convertToLlm(sessionContext.messages);

        const planResponse = await complete(this.options.model, {
          systemPrompt: basePlanningPrompt + localContextSection + retryHint,
          messages: historyMessages,
        }, { apiKey: auth.apiKey, headers: auth.headers, signal, reasoning: 'low' });

        const textContent = planResponse.content.find((c): c is TextContent => c.type === 'text');
        const rawPlanText = textContent?.text || "";
        logger.debug('[Orchestrator] Raw planning response (attempt %d):', attempt, rawPlanText);
        try {
          currentPlan = this.parseJsonPlan(rawPlanText);
          // Track coordinator tokens (only on success — billed attempt)
          const coordUsage = (planResponse as any).usage as Usage | undefined;
          if (coordUsage) {
              const tokens = calculateTotalTokens(coordUsage);
              if (tokens > 0) {
                  const cost = (coordUsage as any).cost?.total ?? 0;
                  this.options.onTokens(tokens);
                  this.options.panelState.totalCost += cost;
                  updateSliceTokens(this.options.panelState, 'coord', tokens, cost);
                  this.options.onUpdate();
              }
          }
          break;
        } catch (err) {
          if (attempt >= 2) throw err;
          logger.warn('[Orchestrator] JSON parse failed on attempt 1, retrying coordinator with explicit JSON reminder');
        }
      }
      // 1. Cap team size deterministically (enforce max siblings per round)
      const maxTeamSize = this.options.complexity === 1 ? MAX_TEAM_SIZE_LEVEL_1 :
                           this.options.complexity === 2 ? MAX_TEAM_SIZE_LEVEL_2 :
                           MAX_TEAM_SIZE_LEVEL_3;

      if (currentPlan.researchers.length > maxTeamSize) {
          const capped = currentPlan.researchers.slice(0, maxTeamSize);
          const keptIds = new Set(capped.map(r => r.id));
          logger.warn(`[Orchestrator] Capping team size from ${currentPlan.researchers.length} to ${maxTeamSize} — kept: ${[...keptIds].join(', ')}`);
          currentPlan.researchers = capped;
          currentPlan.allQueries = capped.flatMap(r => r.queries);
      }

      // 2. Cap individual researcher budgets and global round budget
      currentPlan = this.capResearcherQueries(currentPlan!);
      logger.log(`[Orchestrator] ${this.elapsed()} Coordinator done in ${((Date.now() - coordStartMs) / 1000).toFixed(1)}s — planned ${currentPlan.researchers.length} researcher(s)`);

      // Initialize progress tracking: 1 unit per researcher + 1 per evaluator
      const initialResearchersCount = currentPlan.researchers.length;
      const expectedUnits = (initialResearchersCount * DeepResearchOrchestrator.UNITS_PER_RESEARCHER)
        + DeepResearchOrchestrator.LEAD_EVAL_UNITS;
      this.options.panelState.progress = { expected: expectedUnits, made: 0, extended: false };
      this.options.onUpdate();

      const maxRounds = this.options.complexity === 1 ? MAX_ROUNDS_LEVEL_1 :
                           this.options.complexity === 2 ? MAX_ROUNDS_LEVEL_2 :
                           MAX_ROUNDS_LEVEL_3;
      const hardLimit = maxRounds + MAX_EXTRA_ROUNDS;

      while (this.currentRound <= hardLimit) {
          const roundStartMs = Date.now();
          logger.log(`[Orchestrator] ${this.elapsed()} Round ${this.currentRound} starting (target: ${maxRounds}, hard limit: ${hardLimit})`);

          // PHASE 2: SEARCH BURST (Pre-seed all researchers in round)
          // Round 1: coord slice transitions Planning... → Searching... here.
          // Round 2+: eval slice was left alive by evaluate() with status "Searching..." — no re-add needed.
          let researcherLinks = new Map<string, string[]>();
          if (currentPlan.allQueries && currentPlan.allQueries.length > 0) {
              this.options.panelState.isSearching = true;
              try {
                  if (this.currentRound === 1) {
                      updateSliceStatus(this.options.panelState, 'coord', 'Searching...');
                  } else if (!this.options.panelState.slices.has('eval')) {
                      // Fallback: eval slice wasn't persisted — create it now.
                      addSlice(this.options.panelState, 'eval', 'eval', true);
                      activateSlice(this.options.panelState, 'eval');
                      updateSliceStatus(this.options.panelState, 'eval', 'Searching...');
                  }
                  this.options.onUpdate();

                  const searchStartMs = Date.now();
                  this.allSearchedQueries.push(...currentPlan.allQueries);
                  
                  const onSearchProgress = (completed: number, total: number) => {
                      const status = `Searching: ${completed}/${total}...`;
                      if (this.currentRound === 1) {
                          updateSliceStatus(this.options.panelState, 'coord', status);
                      } else {
                          updateSliceStatus(this.options.panelState, 'eval', status);
                      }
                      this.options.onUpdate();
                  };

                  const searchResults = await search(currentPlan.allQueries, undefined, signal, onSearchProgress);
                  researcherLinks = this.distributeResults(currentPlan, searchResults);
                  logger.log(`[Orchestrator] ${this.elapsed()} Search burst done in ${((Date.now() - searchStartMs) / 1000).toFixed(1)}s — ${currentPlan.allQueries.length} queries`);

                  const newLinks = Array.from(new Set(Array.from(researcherLinks.values()).flat()));
                  this.allScrapedLinks = Array.from(new Set([...this.allScrapedLinks, ...newLinks]));
                  registerScrapedLinks(this.options.panelState.researchId, newLinks);
              } finally {
                  this.options.panelState.isSearching = false;
                  this.options.onUpdate();
              }
          }

          // Clean up the planning/search slice before launching researchers.
          // This is the single point of cleanup for both coord (round 1) and eval (round 2+).
          if (this.currentRound === 1) {
              updateSliceStatus(this.options.panelState, 'coord', undefined);
              completeSlice(this.options.panelState, 'coord');
              removeSlice(this.options.panelState, 'coord');
          } else if (this.options.panelState.slices.has('eval')) {
              updateSliceStatus(this.options.panelState, 'eval', undefined);
              completeSlice(this.options.panelState, 'eval');
              removeSlice(this.options.panelState, 'eval');
          }
          this.options.onUpdate();

          // PHASE 3: EXECUTE RESEARCHERS (Concurrency limited to 3)
          const researchStartMs = Date.now();
          logger.log(`[Orchestrator] ${this.elapsed()} Round ${this.currentRound} researchers launching (${currentPlan.researchers.length} researcher(s))`);
          
          // Clear old researcher slices just before launching new ones.
          // This keeps the TUI occupied during the Search Burst phase.
          if (this.currentRound > 1) {
              const currentRoundIds = new Set(currentPlan.researchers.map(r => r.id.replace(/^r/, '')));
              const toRemove = Array.from(this.options.panelState.slices.keys())
                  .filter(id => id !== 'coord' && id !== 'eval' && !currentRoundIds.has(id));
              for (const id of toRemove) {
                  removeSlice(this.options.panelState, id);
              }
              this.options.onUpdate();
          }

          await this.runResearchersParallel(currentPlan.researchers, researcherLinks, signal);
          logger.log(`[Orchestrator] ${this.elapsed()} Round ${this.currentRound} researchers done in ${((Date.now() - researchStartMs) / 1000).toFixed(1)}s`);

          // PHASE 4: EVALUATE & DECIDE
          const evalStartMs = Date.now();
          const isAtHardLimit = this.currentRound >= hardLimit;
          const isAtTarget = this.currentRound >= maxRounds;
          const evalResult = await this.evaluate(signal, isAtHardLimit, isAtTarget && !isAtHardLimit);
          logger.log(`[Orchestrator] ${this.elapsed()} Round ${this.currentRound} evaluator done in ${((Date.now() - evalStartMs) / 1000).toFixed(1)}s → action=${evalResult.action ?? 'delegate'} (round total: ${((Date.now() - roundStartMs) / 1000).toFixed(1)}s)`);

          if (evalResult.action === 'synthesize' || !evalResult.researchers) {
              if (this.options.panelState.progress) {
                  this.options.panelState.progress.made = this.options.panelState.progress.expected;
                  this.options.panelState.progress.extended = false;
              }
              return evalResult.content || "Research complete.";
          } else if (isAtHardLimit) {
              // Evaluator insisted on delegate despite the mandatory synthesis instruction.
              // Fall through to emergency synthesis below.
              logger.warn('[Orchestrator] Evaluator returned delegate at hard limit — forcing emergency synthesis');
              break;
          } else {
              // DELEGATE: Transition to new round — evaluator planned the next team,
              // no coordinator needed. eval slice will re-appear as Searching... next iteration.
              if (evalResult.researchers.length > maxTeamSize) {
                  const capped = evalResult.researchers.slice(0, maxTeamSize);
                  const keptIds = new Set(capped.map(r => r.id));
                  const keptQueries = capped.flatMap(r => r.queries);
                  logger.warn(`[Orchestrator] Capping evaluator delegation from ${evalResult.researchers.length} to ${maxTeamSize} — kept: ${[...keptIds].join(', ')}`);
                  evalResult.researchers = capped;
                  evalResult.allQueries = keptQueries;
              }
              this.currentRound++;
              currentPlan = this.capResearcherQueries(evalResult);
          }
      }

      // Emergency synthesis: rounds exhausted but reports exist — synthesize them now.
      if (this.reports.size > 0) {
          logger.warn(`[Orchestrator] Round limit reached with ${this.reports.size} report(s); running emergency synthesis`);
          const emergencyResult = await this.evaluate(signal, true);
          if (this.options.panelState.progress) {
              this.options.panelState.progress.made = this.options.panelState.progress.expected;
              this.options.panelState.progress.extended = false;
          }
          return emergencyResult.content || this.buildFallbackSynthesis();
      }
      if (this.options.panelState.progress) {
          this.options.panelState.progress.made = this.options.panelState.progress.expected;
          this.options.panelState.progress.extended = false;
      }
      return "Research complete (no findings).";

    } catch (error) {
      logger.error('[Orchestrator] Run failed:', error);
      throw error;
    } finally {
      this.options.panelState.isSearching = false;
      this.options.onUpdate();
    }
  }

  private getQueryBudget(): number {
    return this.options.complexity === 1
      ? MAX_QUERIES_PER_RESEARCHER_LEVEL_1
      : this.options.complexity === 2
        ? MAX_QUERIES_PER_RESEARCHER_LEVEL_2
        : MAX_QUERIES_PER_RESEARCHER_LEVEL_3;
  }

  private getTeamSize(): number {
    return this.options.complexity === 1
      ? MAX_TEAM_SIZE_LEVEL_1
      : this.options.complexity === 2
        ? MAX_TEAM_SIZE_LEVEL_2
        : MAX_TEAM_SIZE_LEVEL_3;
  }

  private capResearcherQueries(plan: ResearchPlan): ResearchPlan {
    const budget = this.getQueryBudget();
    
    // Scale round cap by complexity: L1=20, L2=40, L3=60
    const ROUND_HARD_CAP = this.options.complexity === 1 ? 20 
                         : this.options.complexity === 2 ? 40 
                         : 60;

    // 1. Cap individual researchers first
    plan.researchers = plan.researchers.map(r => {
      if (r.queries.length > budget) {
        logger.warn(`[Orchestrator] Capping researcher ${r.id} queries: ${r.queries.length} → ${budget}`);
        return { ...r, queries: r.queries.slice(0, budget) };
      }
      return r;
    });

    // 2. Enforce global round hard cap (max 40 queries total)
    let totalQueries = plan.researchers.reduce((sum, r) => sum + r.queries.length, 0);
    if (totalQueries > ROUND_HARD_CAP) {
        logger.warn(`[Orchestrator] Total round queries (${totalQueries}) exceeds hard cap (${ROUND_HARD_CAP}). Trimming...`);
        
        // Simple fair trimming: remove queries from the end of the lists until we fit
        while (totalQueries > ROUND_HARD_CAP) {
            // Find the researcher with the most queries remaining
            let maxIdx = -1;
            let maxCount = -1;
            for (let i = 0; i < plan.researchers.length; i++) {
                if (plan.researchers[i].queries.length > maxCount) {
                    maxCount = plan.researchers[i].queries.length;
                    maxIdx = i;
                }
            }
            if (maxIdx === -1 || maxCount === 0) break; // Should not happen
            
            plan.researchers[maxIdx].queries.pop();
            totalQueries--;
        }
    }

    plan.allQueries = plan.researchers.flatMap(r => r.queries);
    return plan;
  }

  private parseJsonPlan(text: string): ResearchPlan {
    const result = extractJson<ResearchPlan>(text, 'object');
    if (!result.success || !result.value) {
        const preview = text.length > 100 ? text.slice(0, 100) + '...' : text;
        throw new Error(`Failed to extract valid JSON plan: ${result.error}. Raw response preview: "${preview}"`);
    }
    const plan = result.value;
    if (!Array.isArray(plan.researchers)) {
        throw new Error(`Coordinator returned invalid plan: 'researchers' is not an array (got ${JSON.stringify(plan.researchers)})`);
    }
    for (let i = 0; i < plan.researchers.length; i++) {
        const r = plan.researchers[i]!;
        if (!Array.isArray(r.queries)) {
            throw new Error(`Coordinator plan researcher[${i}] (id=${r.id}) has no queries array (got ${JSON.stringify(r.queries)})`);
        }
    }
    return plan;
  }

  private distributeResults(plan: ResearchPlan, results: any[]): Map<string, string[]> {
    const linkMap = new Map<string, string[]>();
    plan.researchers.forEach((r) => {
        const ownedLinks: string[] = [];
        const rQueries = new Set(r.queries.map((q: string) => q.toLowerCase().trim()));
        results.forEach((res: any) => {
            // Match if the search result query exactly matches one of the researcher's queries
            // or if the researcher's query is a close substring match
            const resQuery = String(res.query ?? '').toLowerCase().trim();
            if (rQueries.has(resQuery) || [...rQueries].some((rq) => resQuery.includes(rq) || rq.includes(resQuery))) {
                (res.results ?? []).forEach((item: any) => {
                    if (item?.url) ownedLinks.push(item.url);
                });
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
      const errors: string[] = [];

      while (queue.length > 0 || active.size > 0) {
          if (signal?.aborted) throw new Error("Research aborted.");

          // Fill active slots (up to MAX_CONCURRENT_RESEARCHERS = 3 at once)
          while (active.size < MAX_CONCURRENT_RESEARCHERS && queue.length > 0) {
              if (active.size > 0) await new Promise(resolve => setTimeout(resolve, RESEARCHER_LAUNCH_DELAY_MS));
              const config = queue.shift()!;
              const links = linksMap.get(config.id) || [];
              const p = this.runResearcher(config, links)
                  .catch((err) => {
                      errors.push(`Researcher ${config.id} (${config.name}): ${err.message || err}`);
                  })
                  .finally(() => { active.delete(p); });
              active.add(p);
          }

          // Wait for at least one to finish before spawning next
          if (active.size > 0) await Promise.race(active);
      }

      // Log any researcher failures but don't crash the round
      if (errors.length > 0) {
          logger.warn(`[Orchestrator] ${errors.length} researcher(s) failed (continuing with remaining reports):\n${errors.join('\n')}`);
      }
  }

  private async runResearcher(config: ResearcherConfig, initialLinks: string[]): Promise<void> {
    const displayNum = config.id.replace(/^r/, '');
    const internalId = displayNum;
    const label = displayNum;
    
    addSlice(this.options.panelState, internalId, label, true);
    activateSlice(this.options.panelState, internalId);
    this.options.onUpdate();

    try {
        const systemPromptTemplate = loadPrompt('researcher');
        let researcherPrompt = injectCurrentDate(systemPromptTemplate, 'researcher')
            .replace('{{goal}}', config.goal);

        const seeder = this.currentRound === 1 ? 'Initial Coordinator' : 'Lead Evaluator';
        if (initialLinks.length > 0) {
            researcherPrompt = researcherPrompt.replace('{{evidence_section}}',
                `## Starting Evidence (from ${seeder})\nThe following links were identified through a search pass run by the ${seeder}. Begin your scraping from these:\n\n${initialLinks.join('\n')}`);
        } else {
            researcherPrompt = researcherPrompt.replace('{{evidence_section}}', '');
        }

        const session = await createResearcherSession({
            cwd: this.options.ctx.cwd,
            ctxModel: this.options.model,
            modelRegistry: this.options.ctx.modelRegistry,
            settingsManager: (this.options.ctx as any).settingsManager,
            systemPrompt: researcherPrompt,
            extensionCtx: this.options.ctx,
            noSearch: true,
            onLinksScraped: (links) => this.broadcastLinks(internalId, config.name, links),
            onSearchProgress: (completed, total) => {
                updateSliceStatus(this.options.panelState, internalId, `Searching: ${completed}/${total}...`);
                this.options.onUpdate();
            },
            getGlobalState: () => ({
                researchId: this.options.panelState.researchId,
                rootQuery: this.options.query,
                allScrapedLinks: getScrapedLinks(this.options.panelState.researchId),
            } as SystemResearchState),
            updateGlobalLinks: (links) => registerScrapedLinks(this.options.panelState.researchId, links),
            getTokensUsed: () => this.siblingTokens.get(internalId) ?? 0,
            getScrapeTokens: () => this.siblingScrapeTokens.get(internalId) ?? 0,
            contextWindowSize: (this.options.model as any)?.contextWindow ?? 200000,
        });

        const researcherStartMs = Date.now();
        logger.log(`[Orchestrator] ${this.elapsed()} Researcher ${internalId} started`);

        // Fractional progress credit per tool call (up to 90% of UNITS_PER_RESEARCHER before completion)
        const perToolCredit = DeepResearchOrchestrator.UNITS_PER_RESEARCHER / RESEARCHER_TOOL_BUDGET;
        const maxFractionalCredit = DeepResearchOrchestrator.UNITS_PER_RESEARCHER * 0.9;

        // Track LLM call durations to diagnose performance issues
        // FIX: Use LIFO stack instead of map for accurate timing
        const llmCallStartStack: number[] = [];

        const subscription = session.subscribe((event: AgentSessionEvent) => {
            // Track LLM call timing
            if (event.type === 'message_start') {
                llmCallStartStack.push(Date.now());
                logger.debug(`[Orchestrator] ${this.elapsed()} LLM call started for ${internalId} (stack depth: ${llmCallStartStack.length})`);
            }
            if (event.type === 'message_end') {
                const startTime = llmCallStartStack.pop() || Date.now();
                const duration = Date.now() - startTime;
                logger.debug(`[Orchestrator] ${this.elapsed()} LLM call completed for ${internalId} in ${duration}ms (${(duration/1000).toFixed(1)}s)`);
            }
            if (event.type === 'message_end') {
                const msg = event.message as any;
                if (msg?.role !== 'assistant') return;
                const rawUsage = msg.usage as Usage | undefined;
                const tokens = calculateTotalTokens(rawUsage ?? {});
                // Use the pre-calculated cost from pi-ai (already computed by the provider)
                const cost: number = rawUsage ? ((rawUsage as any).cost?.total ?? 0) : 0;
                if (tokens > 0) {
                    const currentTotal = this.siblingTokens.get(internalId) ?? 0;
                    const newTotal = currentTotal + tokens;
                    this.siblingTokens.set(internalId, newTotal);
                    
                    this.options.onTokens(tokens);
                    this.options.panelState.totalCost += cost;
                    updateSliceTokens(this.options.panelState, label, tokens, cost);
                }
            } else if (event.type === 'tool_execution_end' && !event.isError) {
                // FIX: Track scrape tokens here where event.result is available
                if (event.toolName === 'scrape' && event.result?.details?.count) {
                    const scrapeTokenEstimate = event.result.details.count * AVG_TOKENS_PER_SCRAPE;
                    const currentScrapeTotal = this.siblingScrapeTokens.get(internalId) ?? 0;
                    this.siblingScrapeTokens.set(internalId, currentScrapeTotal + scrapeTokenEstimate);
                }

                // Advance progress fractionally as tools complete, capped at 90% before final credit
                if (this.options.panelState.progress) {
                    const currentCredit = this.progressCredits.get(config.id) ?? 0;
                    if (currentCredit < maxFractionalCredit) {
                        const delta = Math.min(perToolCredit, maxFractionalCredit - currentCredit);
                        this.progressCredits.set(config.id, currentCredit + delta);
                        this.options.panelState.progress.made += delta;
                        this.options.onUpdate();
                    }
                }
            } else if (event.type === 'message_update') {
                const updateMsg = event.message as any;
                if (updateMsg?.role === 'assistant') {
                    const content = updateMsg.content;
                    if (Array.isArray(content)) {
                        const textLen = content
                            .filter(isTextContentBlock)
                            .reduce((sum: number, b: any) => sum + b.text.length, 0);
                        if (textLen > STREAMING_UPDATE_THRESHOLD_CHARS) {
                            const estimate = Math.ceil(textLen / 4);
                            updateSliceTokens(this.options.panelState, label, estimate, 0);
                            this.options.onUpdate();
                        }
                    }
                }
            }
        });

        this.activeSessions.set(internalId, session);
        try {
            // FIX: Enforce researcher timeout to prevent hung sessions
            const config = getConfig();
            const timeoutPromise = new Promise<void>((_, reject) => {
                setTimeout(() => {
                    reject(new Error(`Researcher ${internalId} timed out after ${config.RESEARCHER_TIMEOUT_MS}ms`));
                }, config.RESEARCHER_TIMEOUT_MS);
            });

            await Promise.race([
                session.prompt("Begin your specialized research."),
                timeoutPromise
            ]);
        } catch (error) {
            if (error instanceof Error && error.message?.includes('timed out')) {
                logger.error(`[Orchestrator] ${this.elapsed()} ${error.message}`);
                throw error;
            }
            throw error;
        } finally {
            if (typeof subscription === 'function') subscription();
        }

        const researcherElapsedMs = Date.now() - researcherStartMs;
        logger.log(`[Orchestrator] ${this.elapsed()} Researcher ${internalId} done in ${(researcherElapsedMs / 1000).toFixed(1)}s`);

        const report = ensureAssistantResponse(session, `Researcher ${internalId}`);
        // Store report with round-prefixed key for the evaluator, but use internalId for logging
        this.reports.set(`${this.currentRound}.${internalId}`, report);
        await this.injectCompletionSummary(internalId, config.name, report);

        completeSlice(this.options.panelState, label);

        // Credit the remaining 10% on researcher completion (final credit)
        if (this.options.panelState.progress) {
          const alreadyCredited = this.progressCredits.get(config.id) ?? 0;
          if (alreadyCredited < DeepResearchOrchestrator.UNITS_PER_RESEARCHER) {
            const topUp = DeepResearchOrchestrator.UNITS_PER_RESEARCHER - alreadyCredited;
            this.options.panelState.progress.made += topUp;
            this.progressCredits.set(config.id, DeepResearchOrchestrator.UNITS_PER_RESEARCHER);
            this.options.onUpdate();
          }
        }

        this.activeSessions.delete(internalId);
    } catch (e) {
        completeSlice(this.options.panelState, label);
        this.options.onUpdate();
        this.activeSessions.delete(internalId);
        throw e;
    }
  }

  private broadcastLinks(sourceId: string, _sourceName: string, links: string[]) {
      const updateMsg = formatLightweightLinkUpdate(links, sourceId, _sourceName);
      for (const [id, session] of this.activeSessions) {
          if (id !== sourceId) session.steer(updateMsg).catch(() => {});
      }
      this.allScrapedLinks = Array.from(new Set([...this.allScrapedLinks, ...links]));
      registerScrapedLinks(this.options.panelState.researchId, links);
  }

  private async injectCompletionSummary(sourceId: string, _sourceName: string, fullReport: string) {
      const summary = this.extractSummary(fullReport);
      const urls = this.extractUrls(fullReport);
      const msg = `## Sibling ${sourceId} Completed\n\n### Summary\n${summary}\n\n### URLs\n${urls.map(u => `- ${u}`).join('\n')}\n\n> Adjust your direction.`;
      for (const [id, session] of this.activeSessions) {
          if (id !== sourceId) session.steer(msg).catch(() => {});
      }
  }


  private buildFallbackSynthesis(): string {
    const sections = Array.from(this.reports.entries())
      .map(([id, report]) => `## Researcher ${id} Findings\n\n${report}`)
      .join('\n\n---\n\n');
    return `# Research Findings\n\n${sections}`;
  }

  private async evaluate(signal?: AbortSignal, mustSynthesize = false, atTarget = false): Promise<ResearchPlan> {
      if (!this.options.panelState.slices.has('eval')) {
          addSlice(this.options.panelState, 'eval', 'eval', true);
      }
      activateSlice(this.options.panelState, 'eval');
      updateSliceStatus(this.options.panelState, 'eval', 'Assessing...');
      this.options.onUpdate();

      const maxTeamSize = this.options.complexity === 1 ? MAX_TEAM_SIZE_LEVEL_1 :
                           this.options.complexity === 2 ? MAX_TEAM_SIZE_LEVEL_2 :
                           MAX_TEAM_SIZE_LEVEL_3;
                           
      const previousQueriesList = this.allSearchedQueries.length > 0 
          ? this.allSearchedQueries.map(q => `- ${q}`).join('\n')
          : "None";

      // Calculate next available numeric ID for continuity
      // Previously used "round.rN". Now we just want simple numbers "1", "2", "3"...
      const existingIds = Array.from(this.reports.keys())
          .map(id => { 
              const m = id.match(/(\d+)$/); 
              return m ? parseInt(m[1]!) : NaN; 
          })
          .filter(n => !isNaN(n));
      const nextId = existingIds.length > 0 ? Math.max(...existingIds) + 1 : 1;

      const evalPrompt = loadPrompt('system-lead-evaluator')
          .replace('{ROOT_QUERY}', this.options.query)
          .replace('{ROUND_NUMBER}', this.currentRound.toString())
          .replace('{MAX_ROUNDS}', ((this.options.complexity === 1 ? MAX_ROUNDS_LEVEL_1 : this.options.complexity === 2 ? MAX_ROUNDS_LEVEL_2 : MAX_ROUNDS_LEVEL_3)).toString())
          .replace('{MAX_TEAM_SIZE}', maxTeamSize.toString())
          .replace('{PREVIOUS_QUERIES}', previousQueriesList)
          .replace('{NEXT_ID}', `${nextId}`);

      // FIX: For delegation-only, send only current round's reports to keep input size constant
      let reportsToUse = this.reports;
      if (!mustSynthesize && !atTarget) {
          // Delegation decision: use only current round's reports
          const currentRoundReports = new Map<string, string>();
          for (const [id, report] of this.reports.entries()) {
              if (id.startsWith(`${this.currentRound}.`)) {
                  currentRoundReports.set(id, report);
              }
          }
          reportsToUse = currentRoundReports;
      }
      // For synthesis or at-target, use all reports as before

      const reportsText = Array.from(reportsToUse.entries())
          .map(([id, report]) => {
              return `### Researcher ${id} Report\n\n${report}`;
          })
          .join('\n\n---\n\n');

      const auth = await this.options.ctx.modelRegistry.getApiKeyAndHeaders(this.options.model);
      if (!auth.ok) throw new Error(`Model auth failed: ${auth.error}`);

      const synthOverride = mustSynthesize
          ? '\n\n**MANDATORY — ABSOLUTE MAXIMUM REACHED**: No further research rounds are permitted. You MUST return `"action": "synthesize"` with a comprehensive synthesis in the `content` field. Do NOT return delegate.'
          : atTarget
          ? '\n\n**NOTICE — TARGET DEPTH REACHED**: Synthesize if the research agenda is substantially covered. Only delegate if CRITICAL gaps remain that cannot be resolved from existing findings.'
          : '';

      const response = await completeSimple(this.options.model, {
          messages: [
              {
                  role: 'user',
                  content: [{ type: 'text', text: `Findings so far:\n\n${reportsText}\n\n---\n\n${evalPrompt}${synthOverride}` }],
                  timestamp: Date.now(),
              },
          ]
      }, {
          apiKey: auth.apiKey,
          headers: auth.headers,
          signal,
          reasoning: 'low',
      });

      const textContent = response.content.find((c): c is TextContent => c.type === 'text');
      const text = textContent?.text || "";
      logger.debug('[Orchestrator] Raw evaluator response:', text);

      // Track evaluator tokens
      const evalUsage = (response as any).usage as Usage | undefined;
      if (evalUsage) {
          const tokens = calculateTotalTokens(evalUsage);
          if (tokens > 0) {
              const cost: number = (evalUsage as any).cost?.total ?? 0;
              this.options.onTokens(tokens);
              this.options.panelState.totalCost += cost;
              updateSliceTokens(this.options.panelState, 'eval', tokens, cost);
          }
      }

      // Parse first, then decide what to do with the slice based on outcome.
      const extracted = extractJson<ResearchPlan>(text, 'any');
      let plan: ResearchPlan;
      if (extracted.success && extracted.value) {
          plan = extracted.value;
          if (plan.action === 'synthesize' && !plan.content) {
              plan = { action: 'synthesize', content: text, researchers: [], allQueries: [] };
          }
      } else {
          logger.warn(`[Orchestrator] Evaluator returned malformed JSON (${extracted.error}); defaulting to synthesize`);
          plan = { action: 'synthesize', content: text, researchers: [], allQueries: [] };
      }

      const willDelegate = plan.action !== 'synthesize' && Array.isArray(plan.researchers) && plan.researchers.length > 0 && !mustSynthesize;

      // Track evaluator progress
      if (this.options.panelState.progress) {
        const evalKey = `eval.${this.currentRound}`;
        if (!this.progressCredits.has(evalKey)) {
          this.options.panelState.progress.made += DeepResearchOrchestrator.LEAD_EVAL_UNITS;
          this.progressCredits.set(evalKey, DeepResearchOrchestrator.LEAD_EVAL_UNITS);
        }
        // If delegating to a new round, expand the expected budget and mark as extended
        if (willDelegate && plan.researchers && plan.researchers.length > 0) {
          const newResearcherUnits = plan.researchers.length * DeepResearchOrchestrator.UNITS_PER_RESEARCHER;
          const nextEvalUnits = DeepResearchOrchestrator.LEAD_EVAL_UNITS;
          this.options.panelState.progress.expected += newResearcherUnits + nextEvalUnits;
          this.options.panelState.progress.extended = true;
        }
      }

      if (willDelegate) {
          // Keep the eval slice alive and transition it to "Searching..." so the TUI
          // shows a continuous signal through the upcoming search burst — no flicker.
          updateSliceStatus(this.options.panelState, 'eval', 'Searching...');
      } else {
          updateSliceStatus(this.options.panelState, 'eval', undefined);
          completeSlice(this.options.panelState, 'eval');
          removeSlice(this.options.panelState, 'eval');
      }
      this.options.onUpdate();

      return plan;
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
