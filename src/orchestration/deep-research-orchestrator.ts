/**
 * Deep Research Orchestrator
 *
 * This is the heart of the pi-research system. It implements a multi-round,
 * multi-agent research loop inspired by systems like OpenAI Deep Research.
 */

import { 
    type ExtensionContext, 
    type AgentSessionEvent 
} from '@mariozechner/pi-coding-agent';
import { complete, completeSimple, type Model, type TextContent } from '@mariozechner/pi-ai';
import { calculateTotalTokens, parseTokenUsage } from '../types/llm.ts';
import { logger } from '../logger.ts';
import { getConfig } from '../config.ts';
import type { ResearchPanelState } from '../tui/research-panel.ts';
import { 
    addSlice, 
    activateSlice, 
    clearCompletedResearchers,
    completeSlice, 
    updateSliceTokens,
    updateSliceStatus,
} from '../tui/research-panel.ts';
import { createResearcherSession } from './researcher.ts';
import { search } from '../web-research/search.ts';
import { recordResearcherFailure, shouldStopResearch } from '../utils/session-state.ts';
import type { QueryResultWithError } from '../web-research/types.ts';
import { extractJson } from '../utils/json-utils.ts';
import { ensureAssistantResponse } from '../utils/text-utils.ts';
import {
    MAX_TEAM_SIZE_LEVEL_1,
    MAX_TEAM_SIZE_LEVEL_2,
    MAX_TEAM_SIZE_LEVEL_3,
    MAX_ROUNDS_LEVEL_1,
    MAX_ROUNDS_LEVEL_2,
    MAX_ROUNDS_LEVEL_3,
    MAX_QUERIES_PER_RESEARCHER_LEVEL_1,
    MAX_QUERIES_PER_RESEARCHER_LEVEL_2,
    MAX_QUERIES_PER_RESEARCHER_LEVEL_3,
    RESEARCHER_LAUNCH_DELAY_MS,
    MAX_EXTRA_ROUNDS,
} from '../constants.ts';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { injectCurrentDate } from '../utils/inject-date.ts';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function loadPrompt(name: string): string {
  try {
    const path = join(__dirname, '..', 'prompts', `${name}.md`);
    return readFileSync(path, 'utf-8');
  } catch (err) {
    logger.error(`[Orchestrator] Failed to load prompt: ${name}`, err);
    return '';
  }
}

const ResearcherConfigSchema = Type.Object({
    id: Type.Union([Type.String(), Type.Number()]),
    name: Type.String(),
    goal: Type.String(),
    queries: Type.Array(Type.String())
});

const ResearchPlanSchema = Type.Object({
    action: Type.Optional(Type.Union([Type.Literal('synthesize'), Type.Literal('delegate')])),
    researchers: Type.Optional(Type.Array(ResearcherConfigSchema)),
    allQueries: Type.Optional(Type.Array(Type.String())),
    content: Type.Optional(Type.String())
});

type ResearchPlan = Static<typeof ResearchPlanSchema>;
type ResearcherConfig = Static<typeof ResearcherConfigSchema>;

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
  private reports = new Map<string, string>(); // researcherId -> report
  private currentRound = 0;
  private plan: ResearchPlan | null = null;
  private startTime: number = Date.now();
  private progressCredits = new Map<string, number>(); // researcherId -> units made
  private siblingScrapeTokens = new Map<string, number>(); // researcherId -> estimated scrape tokens
  
  // Weights for progress bar
  private static UNITS_PER_RESEARCHER = 10;
  private static LEAD_EVAL_UNITS = 2;

  constructor(private options: DeepResearchOrchestratorOptions) {}

  private elapsed(): string {
    const s = Math.round((Date.now() - this.startTime) / 1000);
    return `+${s}s`;
  }

  /**
   * Run the multi-round research loop
   */
  async run(signal?: AbortSignal): Promise<string> {
    logger.log(`[Orchestrator] Starting deep research with complexity ${this.options.complexity}`);

    const basePlanningPrompt = injectCurrentDate(loadPrompt('system-coordinator'), 'coordinator')
      .replace(/\{ROOT_QUERY\}/g, this.options.query)
      .replace('{MAX_TEAM_SIZE}', this.getTeamSize().toString())
      .replace('{QUERY_BUDGET}', this.getQueryBudget().toString())
      .replace('{COMPLEXITY_LABEL}', this.options.complexity === 1 ? 'Quick' : this.options.complexity === 2 ? 'Normal' : 'Deep')
      .replace('{COMPLEXITY_GUIDANCE}', this.getComplexityGuidance())
      .replace('{{local_context_section}}', '');

    let currentPlan: ResearchPlan | null = null;
    const coordStartMs = Date.now();

    try {
      // 1. Initial Planning
      addSlice(this.options.panelState, 'coord', `coordinator`, false);
      activateSlice(this.options.panelState, 'coord');
      this.options.onUpdate();

      const auth = await this.options.ctx.modelRegistry.getApiKeyAndHeaders(this.options.model);
      if (!auth.ok) throw new Error(`Model auth failed: ${auth.error}`);

      const historyMessages: any[] = [];
      for (let attempt = 1; attempt <= 3; attempt++) {
        const retryHint = attempt > 1 ? '\n\n**RETRY**: Your previous JSON was malformed. Ensure you return ONLY valid JSON in a code block.' : '';
        
        // Ensure at least one user message is always present. 
        // Some providers/models return empty responses if messages is empty.
        const messages = attempt === 1 
          ? [{ role: 'user', content: [{ type: 'text', text: `Please plan a research team for: "${this.options.query}"` }] }]
          : historyMessages;

        updateSliceStatus(this.options.panelState, 'coord', attempt > 1 ? `Planning (retry ${attempt-1})...` : 'Planning...');
        const planResponse = await complete(this.options.model, {
          systemPrompt: basePlanningPrompt + retryHint,
          messages,
        }, { apiKey: auth.apiKey, headers: auth.headers, signal });

        const textContent = planResponse.content.find((c): c is TextContent => c.type === 'text');
        const rawPlanText = textContent?.text || "";
        
        if (!rawPlanText) {
          logger.warn('[Orchestrator] Model returned no text content in planning response:', JSON.stringify(planResponse.content));
        }
        
        logger.debug('[Orchestrator] Raw planning response (attempt %d):', attempt, rawPlanText);
        
        try {
          currentPlan = this.parseJsonPlan(rawPlanText);

          // Track coordinator tokens (only on success — billed attempt)
          const coordUsageObj = (planResponse as any).usage;
          if (coordUsageObj) {
              const coordUsage = parseTokenUsage(coordUsageObj);
              const tokens = calculateTotalTokens(coordUsage);
              const inputTokens = coordUsage.input ?? 0;
              const modelContextSize = (this.options.model as any)?.contextWindow ?? 200000;
              const percent = ((inputTokens / modelContextSize) * 100).toFixed(1);
              
              logger.debug(`[Orchestrator] coordinator message_end: totalTokens=${tokens} cost=${(coordUsageObj as any).cost?.total ?? 0} context=${inputTokens} (${percent}%)`);

              if (tokens > 0) {
                  const cost = (coordUsageObj as any).cost?.total ?? 0;
                  this.options.onTokens(tokens);
                  this.options.panelState.totalCost += cost;
                  updateSliceTokens(this.options.panelState, 'coord', tokens, cost);
                  this.options.onUpdate();
              }
          }
          break; 
        } catch (err) {
          if (attempt >= 3) throw err;
          
          // Add failed attempt to history for better retry context
          if (attempt === 1) {
            historyMessages.push(messages[0]);
          }
          historyMessages.push({ role: 'assistant', content: planResponse.content });
          historyMessages.push({ role: 'user', content: [{ type: 'text', text: retryHint }] });

          logger.warn(`[Orchestrator] JSON parse failed on attempt ${attempt}, retrying coordinator${attempt === 2 ? ' (no history)' : ' with JSON reminder'}`);
        }
      }

      if (!currentPlan || !currentPlan.researchers) {
          throw new Error('Coordinator failed to plan any researchers.');
      }

      // 1. Cap team size deterministically (enforce max siblings per round)
      const maxTeamSize = this.getTeamSize();

      if (currentPlan.researchers.length > maxTeamSize) {
          const capped = currentPlan.researchers.slice(0, maxTeamSize);
          const keptIds = new Set(capped.map(r => String(r.id)));
          logger.warn(`[Orchestrator] Capping team size from ${currentPlan.researchers.length} to ${maxTeamSize} — kept: ${[...keptIds].join(', ')}`);
          currentPlan.researchers = capped;
          currentPlan.allQueries = capped.flatMap(r => r.queries);
      }

      // 2. Cap individual researcher budgets and global round budget
      currentPlan = this.capResearcherQueries(currentPlan);
      if (!currentPlan.researchers) throw new Error('No researchers planned after capping.');
      
      logger.log(`[Orchestrator] ${this.elapsed()} Coordinator done in ${((Date.now() - coordStartMs) / 1000).toFixed(1)}s — planned ${currentPlan.researchers.length} researcher(s)`);

      // Initialize progress tracking: 1 unit per researcher + 1 per evaluator
      const initialResearchersCount = currentPlan.researchers.length;
      const expectedUnits = (initialResearchersCount * DeepResearchOrchestrator.UNITS_PER_RESEARCHER)
        + DeepResearchOrchestrator.LEAD_EVAL_UNITS;
      this.options.panelState.progress = { expected: expectedUnits, made: 0 };
      this.options.onUpdate();

      const maxRounds = this.options.complexity === 1 ? MAX_ROUNDS_LEVEL_1 :
                           this.options.complexity === 2 ? MAX_ROUNDS_LEVEL_2 :
                           MAX_ROUNDS_LEVEL_3;

      // 2. Iterative Research Loop
      while (this.currentRound < maxRounds + MAX_EXTRA_ROUNDS) {
          if (signal?.aborted) throw new Error("Research aborted.");
          this.currentRound++;
          
          // Clear completed researchers from previous rounds for clean TUI display
          clearCompletedResearchers(this.options.panelState);
          
          if (!currentPlan || !currentPlan.researchers) break;
          
          logger.log(`[Orchestrator] ${this.elapsed()} Round ${this.currentRound} researchers launching (${currentPlan.researchers.length} researcher(s))`);
          
          // Initial search burst for this round
          if (currentPlan.allQueries && currentPlan.allQueries.length > 0) {
              // Use coord slice for round 1, eval slice for subsequent rounds to avoid "extra" boxes
              const sliceId = this.currentRound === 1 ? 'coord' : 'eval';
              updateSliceStatus(this.options.panelState, sliceId, '0 Results');
              this.options.panelState.isSearching = true;
              this.options.onUpdate();

              const searchStart = Date.now();
              let searchResults;
              try {
                  searchResults = await search(currentPlan.allQueries, undefined, signal, (links) => {
                      updateSliceStatus(this.options.panelState, sliceId, `${links} Results`);
                      this.options.onUpdate();
                  });
              } finally {
                  this.options.panelState.isSearching = false;
                  this.options.onUpdate();
              }
              logger.info(`[Orchestrator] ${this.elapsed()} Search burst done in ${((Date.now() - searchStart) / 1000).toFixed(1)}s — ${currentPlan.allQueries.length} queries`);

              if (this.currentRound === 1) completeSlice(this.options.panelState, 'coord');

              // Distribute results to researchers
              const researcherLinks = this.distributeResults(currentPlan, searchResults);
              await this.runResearchersParallel(currentPlan.researchers, researcherLinks, signal);
          } else {
              if (this.currentRound === 1) completeSlice(this.options.panelState, 'coord');
              await this.runResearchersParallel(currentPlan.researchers, new Map(), signal);
          }


          logger.info(`[Orchestrator] ${this.elapsed()} Round ${this.currentRound} researchers done`);

          // Evaluation Phase
          const mustSynthesize = this.currentRound >= maxRounds + MAX_EXTRA_ROUNDS;

          this.plan = currentPlan;
          currentPlan = await this.evaluate(signal, mustSynthesize);

          if (currentPlan.action === 'synthesize') {
              const synthesis = currentPlan.content || this.buildFallbackSynthesis();
              completeSlice(this.options.panelState, 'eval');
              if (this.options.panelState.progress) {
                  this.options.panelState.progress.made = this.options.panelState.progress.expected;
              }
              this.options.onUpdate(); // Ensure TUI reflects final state
              return synthesis;
          }

          // If delegating to a new round, expand the expected budget
          if (currentPlan.researchers && currentPlan.researchers.length > 0) {
              const newResearcherUnits = currentPlan.researchers.length * DeepResearchOrchestrator.UNITS_PER_RESEARCHER;
              const nextEvalUnits = DeepResearchOrchestrator.LEAD_EVAL_UNITS;
              if (this.options.panelState.progress) {
                  this.options.panelState.progress.expected += newResearcherUnits + nextEvalUnits;
              }
          }
      }

      // Final fallback if we somehow exited the loop without synthesis
      logger.warn('[Orchestrator] Exited loop without explicit synthesis; building fallback.');
      const synthesis = this.buildFallbackSynthesis();
      if (this.options.panelState.progress) {
          this.options.panelState.progress.made = this.options.panelState.progress.expected;
      }
      return synthesis;

    } catch (error) {
      if (error instanceof Error && error.message === 'Research aborted.') {
        throw error;
      }
      logger.error('[Orchestrator] Run failed:', error);
      if (this.reports.size > 0) {
          logger.warn('[Orchestrator] Attempting fallback synthesis from partial findings...');
          return this.buildFallbackSynthesis();
      }
      if (this.options.panelState.progress) {
          this.options.panelState.progress.made = this.options.panelState.progress.expected;
      }
      return "Research failed. Check debug logs for details.";
    }
  }

  private getTeamSize(): number {
    return this.options.complexity === 1 ? MAX_TEAM_SIZE_LEVEL_1 :
           this.options.complexity === 2 ? MAX_TEAM_SIZE_LEVEL_2 :
           MAX_TEAM_SIZE_LEVEL_3;
  }

  private getQueryBudget(): number {
    return this.options.complexity === 1 ? MAX_QUERIES_PER_RESEARCHER_LEVEL_1 :
           this.options.complexity === 2 ? MAX_QUERIES_PER_RESEARCHER_LEVEL_2 :
           MAX_QUERIES_PER_RESEARCHER_LEVEL_3;
  }

  private getComplexityGuidance(): string {
    if (this.options.complexity === 1) {
      return "**Complexity: Level 1 (Quick)**. Aim for a focused, direct investigation of the primary facts.";
    } else if (this.options.complexity === 2) {
      return "**Complexity: Level 2 (Normal)**. Conduct a thorough investigation covering multiple angles and sources.";
    } else {
      return "**Complexity: Level 3 (Ultra)**. Perform an exhaustive, deep-dive research effort, leaving no stone unturned. **IMPORTANT**: Plan aggressively for multiple research rounds. In your initial planning, deploy the maximum number of researchers ({MAX_TEAM_SIZE}) and fully utilize each researcher's query budget ({QUERY_BUDGET}). Think in terms of a multi-phase investigation: plan Round 1 to broadly map the landscape with parallel specialists, anticipating that subsequent rounds will drill down into specific gaps. Don't hold back — leverage all available researchers and queries in Round 1 to maximize initial coverage.";
    }
  }

  private getEvaluatorComplexityGuidance(): string {
    if (this.options.complexity === 1) {
      return `**Level 1 (Quick)** - Focused, direct investigation.

- **SYNTHESIZE when**: Primary facts are established, core question is answerable
- **DELEGATE only when**: Essential information missing, critical gaps that prevent answering

Be conservative with delegation. The goal is efficiency — answer the core question directly without exhaustive coverage.`;
    } else if (this.options.complexity === 2) {
      return `**Level 2 (Normal)** - Thorough, multi-angle investigation.

- **SYNTHESIZE when**: Multiple angles covered, substantial findings available, research agenda substantially addressed
- **DELEGATE when**: Important gaps remain, additional perspectives would significantly improve completeness

Balance thoroughness with efficiency. Delegate when new rounds would meaningfully enhance the depth or breadth of findings.`;
    } else {
      return `**Level 3 (Ultra)** - Exhaustive, comprehensive deep-dive.

- **SYNTHESIZE when**: Exhaustively covered across all substantial avenues, no meaningful gaps, no significant unexplored angles
- **DELEGATE when**: ANY meaningful gaps, nuances, or angles remain. Prioritize thoroughness over efficiency. Lean heavily toward delegation for completeness.

Be aggressive with delegation. Level 3 is for exhaustive research — don't stop early. Use remaining rounds to drill into specialized details, verify findings, or explore nuanced dimensions. Only synthesize when you've truly exhausted substantial research avenues.`;
    }
  }

  private getRoundPhaseGuidance(maxRounds: number): string {
    const roundRatio = this.currentRound / maxRounds;
    
    if (roundRatio <= 0.5) {
      // Early rounds: be more aggressive with delegation
      return `

---

**Round Phase: EARLY (Round ${this.currentRound} of ${maxRounds})**

You are in the early phase of research. Be more permissive with delegation:
- Deploy researchers to broadly map the landscape
- Don't worry if findings are incomplete — later rounds can fill gaps
- Focus on breadth and initial exploration
- Use available researchers to cover distinct angles in parallel`;
    } else if (roundRatio <= 0.8) {
      // Middle rounds: balanced approach
      return `

---

**Round Phase: MIDDLE (Round ${this.currentRound} of ${maxRounds})**

You are in the middle phase of research. Apply balanced judgment:
- Synthesize if you have substantial coverage of the key aspects
- Delegate for significant gaps or to explore specialized sub-topics
- Consider depth over breadth at this stage
- Focus on rounding out incomplete areas`;
    } else {
      // Late rounds: higher threshold for delegation
      return `

---

**Round Phase: LATE (Round ${this.currentRound} of ${maxRounds})**

You are in the late phase of research. Set a higher threshold for delegation:
- Synthesize if the core question is answerable with current findings
- Delegate only for CRITICAL gaps that cannot be resolved from existing findings
- Avoid delegating for minor details or marginal improvements
- Focus on delivering a complete, coherent response`;
    }
  }

  /**
   * Limit the number of queries planned per round to prevent context overflow.
   */
  private capResearcherQueries(plan: ResearchPlan): ResearchPlan {
    const budget = this.getQueryBudget();
    
    const ROUND_HARD_CAP = this.options.complexity === 1 ? 20 
                         : this.options.complexity === 2 ? 40
                         : 60;

    if (!plan.researchers) return plan;

    // 1. Normalize IDs to strings and cap individual researchers
    plan.researchers = plan.researchers
      .filter(r => r && typeof r === 'object' && Array.isArray(r.queries))
      .map(r => {
        const normalized = { ...r, id: String(r.id) };
        if (normalized.queries.length > budget) {
          logger.warn(`[Orchestrator] Capping researcher ${normalized.id} queries: ${normalized.queries.length} → ${budget}`);
          normalized.queries = normalized.queries.slice(0, budget);
        }
        return normalized;
      });

    // 2. Enforce global round budget
    let totalQueries = plan.researchers.reduce((sum, r) => sum + r.queries.length, 0);
    if (totalQueries > ROUND_HARD_CAP) {
        logger.warn(`[Orchestrator] Total round queries (${totalQueries}) exceeds hard cap (${ROUND_HARD_CAP}). Trimming...`);
        while (totalQueries > ROUND_HARD_CAP) {
            let maxCount = 0;
            let maxIdx = -1;
            if (!plan.researchers) break;
            for (let i = 0; i < plan.researchers.length; i++) {
                if (plan.researchers[i]!.queries.length > maxCount) {
                    maxCount = plan.researchers[i]!.queries.length;
                    maxIdx = i;
                }
            }
            if (maxIdx === -1) break;
            plan.researchers[maxIdx]!.queries.pop();
            totalQueries--;
        }
    }
    
    plan.allQueries = plan.researchers.flatMap(r => r.queries);
    return plan;
  }

  private parseJsonPlan(text: string): ResearchPlan {
    const result = extractJson<unknown>(text, 'object');
    if (!result.success || !result.value) {
        const preview = text.length > 100 ? text.slice(0, 100) + '...' : text;
        throw new Error(`Failed to extract valid JSON plan: ${result.error}. Raw response preview: "${preview}"`);
    }

    // Robust validation using TypeBox
    try {
        const plan = Value.Convert(ResearchPlanSchema, result.value) as ResearchPlan;
        
        if (!Value.Check(ResearchPlanSchema, plan)) {
            const errors = [...Value.Errors(ResearchPlanSchema, plan)];
            logger.warn(`[Orchestrator] Plan validation failed: ${errors.map(e => String(e.message)).join(', ')}`);
        }

        if (!Array.isArray(plan.researchers)) {
            throw new Error(`Coordinator returned invalid plan: 'researchers' is not an array`);
        }
        
        plan.researchers.forEach((r, i) => {
            r.id = String(r.id);
            if (!Array.isArray(r.queries)) {
                throw new Error(`Coordinator plan researcher[${i}] (id=${r.id}) has no queries array`);
            }
        });

        return plan;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Plan validation error: ${msg}`, { cause: err });
    }
  }

  private distributeResults(plan: ResearchPlan, results: QueryResultWithError[]): Map<string, string[]> {
    const linkMap = new Map<string, string[]>();
    if (!plan.researchers) return linkMap;

    plan.researchers.forEach((r) => {
        const ownedLinks: string[] = [];
        const rQueries = new Set(r.queries.map((q: string) => q.toLowerCase().trim()));
        results.forEach((res) => {
            const resQuery = String(res.query ?? '').toLowerCase().trim();
            if (rQueries.has(resQuery) || [...rQueries].some((rq) => resQuery.includes(rq) || rq.includes(resQuery))) {
                (res.results ?? []).forEach((item) => {
                    if (item?.url) ownedLinks.push(item.url);
                });
            }
        });
        linkMap.set(String(r.id), Array.from(new Set(ownedLinks)));
    });
    return linkMap;
  }

  private async runResearchersParallel(configs: ResearcherConfig[], linksMap: Map<string, string[]>, signal?: AbortSignal) {
      const queue = [...configs];
      const active = new Set<Promise<void>>();
      const errors: string[] = [];

      while (queue.length > 0 || active.size > 0) {
          if (signal?.aborted) throw new Error("Research aborted.");

          const { MAX_CONCURRENT_RESEARCHERS } = getConfig();

          // Fill active slots
          while (active.size < MAX_CONCURRENT_RESEARCHERS && queue.length > 0) {
              if (active.size > 0) await new Promise(resolve => setTimeout(resolve, RESEARCHER_LAUNCH_DELAY_MS));
              const config = queue.shift()!;
              const links = linksMap.get(String(config.id)) || [];
              const p = this.runResearcher(config, links, signal)
                  .catch((err) => {
                      errors.push(`Researcher ${config.id} (${config.name}): ${err.message || err}`);
                      recordResearcherFailure(this.options.panelState.sessionId, this.options.panelState.researchId, String(config.id));
                  })
                  .finally(() => { active.delete(p); });
              active.add(p);
          }

          // Wait for at least one to finish before spawning next
          if (active.size > 0) {
              await Promise.race(active);
              
              if (shouldStopResearch(this.options.panelState.sessionId, this.options.panelState.researchId)) {
                  throw new Error("Research stopped due to excessive infrastructure failures. Multiple researchers failed.");
              }
          }
      }

      // Log any remaining researcher failures
      if (errors.length > 0) {
          logger.warn(`[Orchestrator] ${errors.length} researcher(s) failed in this round:\n${errors.join('\n')}`);
      }
  }

  private async runResearcher(config: ResearcherConfig, initialLinks: string[], _signal?: AbortSignal): Promise<void> {
    const displayNum = String(config.id).replace(/^r/, '');
    const internalId = displayNum;
    const label = displayNum;
    
    addSlice(this.options.panelState, internalId, label, true);
    activateSlice(this.options.panelState, internalId);
    this.options.onUpdate();

    const previousQueriesSection = this.plan?.allQueries && this.plan.allQueries.length > 0
        ? `\n### Previous Queries (Sibling Researchers)\n${this.plan.allQueries.map(q => `- ${q}`).join('\n')}\n`
        : '';

    const researcherPromptTemplate = readFileSync(join(__dirname, '..', 'prompts', 'researcher.md'), 'utf-8');
    const evidenceSection = `## Evidence Provided\n${initialLinks.length > 0 ? `Initial search results provided the following URLs to investigate:\n${initialLinks.map(l => `- ${l}`).join('\n')}` : 'No initial URLs provided. Perform a web search to begin.'}`;
    const prompt = injectCurrentDate(researcherPromptTemplate, 'researcher')
      .replace('{{goal}}', config.goal)
      .replace('{{evidence_section}}', evidenceSection)
      .replace('{{coordination_section}}', previousQueriesSection)
      .replace('{{extra_tool_guidelines}}', '');

    const extendedCtx = this.options.ctx as any;
    let researcherTokens = 0;
    const modelContextSize = (this.options.model as any)?.contextWindow ?? 200000;

    const session = await createResearcherSession({
      cwd: this.options.ctx.cwd,
      ctxModel: this.options.model,
      modelRegistry: this.options.ctx.modelRegistry,
      settingsManager: extendedCtx.settingsManager,
      systemPrompt: prompt,
      extensionCtx: this.options.ctx,
      noSearch: true,
      onSearchProgress: (links) => {
          updateSliceStatus(this.options.panelState, internalId, `${links} Results`);
          this.options.onUpdate();
      },
      getTokensUsed: () => researcherTokens,
      getScrapeTokens: () => this.siblingScrapeTokens.get(internalId) ?? 0,
      contextWindowSize: modelContextSize,
    });

    const llmCallStartStack: number[] = [];
    const subscription = session.subscribe((event: AgentSessionEvent) => {
        if (event.type === 'message_start') {
            llmCallStartStack.push(Date.now());
            logger.debug(`[Orchestrator] ${this.elapsed()} LLM call started for ${internalId}`);
        } else if (event.type === 'message_end') {
            const startTime = llmCallStartStack.pop() || Date.now();
            const duration = Date.now() - startTime;
            
            const msg = event.message as any;
            if (msg?.role !== 'assistant') return;
            const rawUsage = msg.usage;
            if (rawUsage) {
                const parsed = parseTokenUsage(rawUsage);
                const tokens = calculateTotalTokens(parsed);
                const inputTokens = parsed.input ?? 0;
                const percent = ((inputTokens / modelContextSize) * 100).toFixed(1);
                const cost: number = rawUsage ? ((rawUsage as any).cost?.total ?? 0) : 0;
                
                logger.debug(`[Orchestrator] ${this.elapsed()} LLM call for ${internalId} in ${duration}ms: totalTokens=${tokens} cost=${cost} context=${inputTokens} (${percent}%)`);

                if (tokens > 0) {
                    researcherTokens += tokens;
                    this.options.onTokens(tokens);
                }
                if (cost > 0) {
                    this.options.panelState.totalCost += cost;
                }
                if (tokens > 0 || cost > 0) {
                    updateSliceTokens(this.options.panelState, internalId, tokens, cost);
                    this.options.onUpdate();
                }
            }
        } else if (event.type === 'tool_execution_start') {
            updateSliceStatus(this.options.panelState, internalId, `${event.toolName}`);
            this.options.onUpdate();
        } else if (event.type === 'tool_execution_end') {
            updateSliceStatus(this.options.panelState, internalId, undefined);
            
            if (!event.isError) {
                // Track estimated scrape tokens for the context gate
                if (event.toolName === 'scrape' && (event.result as any)?.details?.count) {
                    const { AVG_TOKENS_PER_SCRAPE } = getConfig();
                    const scrapeCount = (event.result as any).details.count;
                    const estimatedTokens = scrapeCount * AVG_TOKENS_PER_SCRAPE;
                    const currentScrapeTotal = this.siblingScrapeTokens.get(internalId) ?? 0;
                    this.siblingScrapeTokens.set(internalId, currentScrapeTotal + estimatedTokens);
                }

                if (this.options.panelState.progress) {
                    const currentCredit = this.progressCredits.get(String(config.id)) ?? 0;
                    const delta = 1;
                    if (currentCredit + delta <= DeepResearchOrchestrator.UNITS_PER_RESEARCHER) {
                        this.options.panelState.progress.made += delta;
                        this.progressCredits.set(String(config.id), currentCredit + delta);
                    }
                }
            }
            this.options.onUpdate();
        }
    });

    try {
      const { getConfig } = await import('../config.ts');
      const configObj = getConfig();
      
      const timeoutPromise = new Promise<void>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Researcher ${internalId} timed out after ${configObj.RESEARCHER_TIMEOUT_MS}ms`));
        }, configObj.RESEARCHER_TIMEOUT_MS);
      });

      await Promise.race([
        session.prompt(`Topic: ${config.name}\nGoal: ${config.goal}\n\nPerform your research and submit your full report now.`),
        timeoutPromise
      ]);
      const responseText = ensureAssistantResponse(session, String(config.id));
      this.reports.set(`${this.currentRound}.${config.id}`, responseText);
      
      // Ensure we credit the full amount for this researcher upon completion
      if (this.options.panelState.progress) {
          const alreadyCredited = this.progressCredits.get(String(config.id)) ?? 0;
          const remaining = DeepResearchOrchestrator.UNITS_PER_RESEARCHER - alreadyCredited;
          if (remaining > 0) {
            this.options.panelState.progress.made += remaining;
            this.progressCredits.set(String(config.id), DeepResearchOrchestrator.UNITS_PER_RESEARCHER);
          }
      }
    } finally {
      subscription();
      completeSlice(this.options.panelState, internalId);
      this.options.onUpdate();
    }
  }

  private buildFallbackSynthesis(): string {
    const sections = Array.from(this.reports.entries())
      .map(([_id, report]) => report)
      .join('\n\n---\n\n');
    return `# Research Findings\n\n${sections}`;
  }

  private async evaluate(signal?: AbortSignal, mustSynthesize = false): Promise<ResearchPlan> {
      addSlice(this.options.panelState, 'eval', 'eval', false);
      activateSlice(this.options.panelState, 'eval');
      updateSliceStatus(this.options.panelState, 'eval', 'Assessing...');
      this.options.onUpdate();

      const previousQueriesSection = this.plan?.allQueries && this.plan.allQueries.length > 0
          ? `\n### Previous Queries (Sibling Researchers)\n${this.plan.allQueries.map(q => `- ${q}`).join('\n')}\n`
          : '';

      const nextId = this.plan?.researchers ? this.plan.researchers.length + 1 : 1;
      const maxTeamSize = this.getTeamSize();

      const maxRounds = this.options.complexity === 1 ? MAX_ROUNDS_LEVEL_1 :
                           this.options.complexity === 2 ? MAX_ROUNDS_LEVEL_2 :
                           MAX_ROUNDS_LEVEL_3;

      const evalPrompt = injectCurrentDate(loadPrompt('system-lead-evaluator'), 'evaluator')
          .replace(/\{ROOT_QUERY\}/g, this.options.query)
          .replace('{ROUND_NUMBER}', this.currentRound.toString())
          .replace('{MAX_ROUNDS}', maxRounds.toString())
          .replace('{MAX_TEAM_SIZE}', maxTeamSize.toString())
          .replace('{QUERY_BUDGET}', this.getQueryBudget().toString())
          .replace('{COMPLEXITY_LABEL}', this.options.complexity === 1 ? 'Level 1 (Quick)' : this.options.complexity === 2 ? 'Level 2 (Normal)' : 'Level 3 (Ultra)')
          .replace('{COMPLEXITY_GUIDANCE}', this.getEvaluatorComplexityGuidance())
          .replace('{ROUND_PHASE_GUIDANCE}', this.getRoundPhaseGuidance(maxRounds))
          .replace('{{previous_queries_section}}', previousQueriesSection)
          .replace('{NEXT_ID}', `${nextId}`);

      // Always send ALL reports to the evaluator for full context
      const reportsToUse = this.reports;

      const reportsText = Array.from(reportsToUse.entries())
          .map(([id, report]) => {
              // Strip round prefix ("1.2" → "2") so evaluator sees sequential IDs, not "round.id"
              const displayId = id.includes('.') ? id.split('.').slice(1).join('.') : id;
              return `### Researcher ${displayId} Report\n\n${report}`;
          })
          .join('\n\n---\n\n');

      const auth = await this.options.ctx.modelRegistry.getApiKeyAndHeaders(this.options.model);
      if (!auth.ok) throw new Error(`Model auth failed: ${auth.error}`);

      // Hard stop override — only apply when absolute limit reached
      const synthOverride = mustSynthesize
          ? '\n\n**MANDATORY — ABSOLUTE MAXIMUM REACHED**: No further research rounds are permitted. You MUST return `"action": "synthesize"` with a comprehensive synthesis in the `content` field. Do NOT return delegate.'
          : '';

      const evalUserMessage = `${evalPrompt}${synthOverride}\n\n---\n\nFindings so far:\n\n${reportsText}`;
      
      let text = "";
      for (let evalAttempt = 1; evalAttempt <= 2; evalAttempt++) {
          const response = await completeSimple(this.options.model, {
              messages: [
                  {
                      role: 'user',
                      content: [{ type: 'text', text: evalUserMessage }],
                      timestamp: Date.now(),
                  },
              ]
          }, {
              apiKey: auth.apiKey,
              headers: auth.headers,
              signal,
          });

          const textContent = response.content.find((c): c is TextContent => c.type === 'text');
          text = textContent?.text || "";
          logger.debug('[Orchestrator] Raw evaluator response (attempt %d):', evalAttempt, text);

          // Track evaluator tokens on every billed attempt
          const evalUsageObj = (response as any).usage;
          if (evalUsageObj) {
              const evalUsage = parseTokenUsage(evalUsageObj);
              const tokens = calculateTotalTokens(evalUsage);
              const inputTokens = evalUsage.input ?? 0;
              const modelContextSize = (this.options.model as any)?.contextWindow ?? 200000;
              const percent = ((inputTokens / modelContextSize) * 100).toFixed(1);
              const cost: number = (evalUsageObj as any).cost?.total ?? 0;
              
              logger.debug(`[Orchestrator] eval message_end: totalTokens=${tokens} cost=${cost} input=${inputTokens} (${percent}%) output=${(evalUsageObj as any)?.output}`);
              
              if (tokens > 0) {
                  this.options.onTokens(tokens);
              }
              if (cost > 0) {
                  this.options.panelState.totalCost += cost;
              }
              if (tokens > 0 || cost > 0) {
                  updateSliceTokens(this.options.panelState, 'eval', tokens, cost);
              }
          }

          if (text.trim()) break; // Got a real response
          if (evalAttempt < 2) {
              logger.warn('[Orchestrator] Evaluator returned empty response, retrying');
          }
      }
      logger.debug('[Orchestrator] Evaluator final text:', text.slice(0, 200));

      // Parse first, then decide what to do with the slice based on outcome.
      const extracted = extractJson<ResearchPlan>(text, 'any');
      let plan: ResearchPlan;
      if (extracted.success && extracted.value) {
          plan = extracted.value;
          // Sanitization: Ensure researchers is a valid array of objects
          if (plan.action === 'delegate') {
              if (!Array.isArray(plan.researchers)) {
                  logger.warn('[Orchestrator] Evaluator returned delegate but researchers is not an array; defaulting to synthesize');
                  plan.action = 'synthesize';
              } else {
                  // Filter out non-objects (e.g. LLM returned [1, 2, 3] instead of objects)
                  plan.researchers = plan.researchers.filter(r => r && typeof r === 'object' && Array.isArray(r.queries));
                  if (plan.researchers.length === 0) {
                      logger.warn('[Orchestrator] Evaluator returned 0 valid researcher objects; defaulting to synthesize');
                      plan.action = 'synthesize';
                  }
              }

              // Ensure allQueries is a valid array of strings
              if (!Array.isArray(plan.allQueries)) {
                  plan.allQueries = plan.researchers ? plan.researchers.flatMap(r => r.queries) : [];
              } else {
                  plan.allQueries = plan.allQueries.filter(q => typeof q === 'string');
              }
          }
          
          if (plan.action === 'synthesize' && !plan.content) {
              plan = { action: 'synthesize', content: text, researchers: [], allQueries: [] };
          }
      } else {
          logger.warn(`[Orchestrator] Evaluator returned malformed JSON (${extracted.error}); defaulting to synthesize`);
          plan = { action: 'synthesize', content: text, researchers: [], allQueries: [] };
      }

      if (!plan) throw new Error('Failed to determine research plan.');

      const willDelegate = plan.action !== 'synthesize' && Array.isArray(plan.researchers) && plan.researchers.length > 0 && !mustSynthesize;

      // Track evaluator progress
      if (this.options.panelState.progress) {
        const evalKey = `eval.${this.currentRound}`;
        if (!this.progressCredits.has(evalKey)) {
          this.options.panelState.progress.made += DeepResearchOrchestrator.LEAD_EVAL_UNITS;
          this.progressCredits.set(evalKey, DeepResearchOrchestrator.LEAD_EVAL_UNITS);
        }
      }

      if (willDelegate) {
          // Transition eval slice to "Results..." for search burst
          updateSliceStatus(this.options.panelState, 'eval', 'Results...');
          return this.capResearcherQueries(plan);
      } else {
          return plan;
      }
  }
}
