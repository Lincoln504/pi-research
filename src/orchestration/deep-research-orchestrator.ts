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
import { getConfig, type Config } from '../config.ts';
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
import type { ResearchObserver } from './research-observer.ts';

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
  sessionId: string;
  researchId: string;
  observer?: ResearchObserver;
  config?: Config;
}

export class DeepResearchOrchestrator {
  private reports = new Map<string, string>(); // researcherId -> report
  private currentRound = 0;
  private plan: ResearchPlan | null = null;
  private startTime: number = Date.now();
  private config: Config;
  private allQueriesHistory: string[] = [];
  private totalResearchersPlanned: number = 0;

  constructor(private options: DeepResearchOrchestratorOptions) {
    this.config = options.config || getConfig();
  }

  private elapsed(): string {
    const s = Math.round((Date.now() - this.startTime) / 1000);
    return `+${s}s`;
  }

  /**
   * Run the multi-round research loop
   */
  async run(signal?: AbortSignal): Promise<string> {
    logger.log(`[Orchestrator] Starting deep research with complexity ${this.options.complexity}`);
    this.options.observer?.onStart?.(this.options.query, this.options.complexity);

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
      this.options.observer?.onPlanningStart?.(1);

      const auth = await this.options.ctx.modelRegistry.getApiKeyAndHeaders(this.options.model);
      if (!auth.ok) throw new Error(`Model auth failed: ${auth.error}`);

      const historyMessages: any[] = [];
      for (let attempt = 1; attempt <= 3; attempt++) {
        if (attempt > 1) this.options.observer?.onPlanningStart?.(attempt);
        const retryHint = attempt > 1 ? '\n\n**RETRY**: Your previous JSON was malformed. Ensure you return ONLY valid JSON in a code block.' : '';
        const messages = attempt === 1 
          ? [{ role: 'user', content: [{ type: 'text', text: `Please plan a research team for: "${this.options.query}"` }] }]
          : historyMessages;

        this.options.observer?.onPlanningProgress?.(attempt > 1 ? `Planning (retry ${attempt-1})...` : 'Planning...');
        const planResponse = await complete(this.options.model, {
          systemPrompt: basePlanningPrompt + retryHint,
          messages,
        }, { apiKey: auth.apiKey, headers: auth.headers, signal });

        const textContent = planResponse.content.find((c): c is TextContent => c.type === 'text');
        const rawPlanText = textContent?.text || "";
        
        try {
          currentPlan = this.parseJsonPlan(rawPlanText);

          const coordUsageObj = (planResponse as any).usage;
          if (coordUsageObj) {
              const coordUsage = parseTokenUsage(coordUsageObj);
              const tokens = calculateTotalTokens(coordUsage);
              const cost = (coordUsageObj as any).cost?.total ?? 0;
              this.options.observer?.onPlanningTokens?.(tokens, cost);
              this.options.observer?.onTokensConsumed?.(tokens, cost);
          }
          this.options.observer?.onPlanningSuccess?.(currentPlan);
          break; 
        } catch (err) {
          if (attempt >= 3) throw err;
          if (attempt === 1) historyMessages.push(messages[0]);
          historyMessages.push({ role: 'assistant', content: planResponse.content });
          historyMessages.push({ role: 'user', content: [{ type: 'text', text: retryHint }] });
        }
      }

      if (!currentPlan || !currentPlan.researchers) throw new Error('Coordinator failed to plan any researchers.');

      const maxTeamSize = this.getTeamSize();
      if (currentPlan.researchers.length > maxTeamSize) {
          currentPlan.researchers = currentPlan.researchers.slice(0, maxTeamSize);
          currentPlan.allQueries = currentPlan.researchers.flatMap(r => r.queries);
      }
      currentPlan = this.capResearcherQueries(currentPlan);
      
      logger.log(`[Orchestrator] ${this.elapsed()} Coordinator done in ${((Date.now() - coordStartMs) / 1000).toFixed(1)}s — planned ${currentPlan.researchers?.length || 0} researcher(s)`);

      const maxRounds = this.options.complexity === 1 ? MAX_ROUNDS_LEVEL_1 :
                           this.options.complexity === 2 ? MAX_ROUNDS_LEVEL_2 :
                           MAX_ROUNDS_LEVEL_3;

      while (this.currentRound < maxRounds + MAX_EXTRA_ROUNDS) {
          if (signal?.aborted) throw new Error("Research aborted.");
          this.currentRound++;
          if (!currentPlan || !currentPlan.researchers) break;
          
          this.options.observer?.onRoundStart?.(this.currentRound);
          // 2. Search Burst
          if (currentPlan.allQueries && currentPlan.allQueries.length > 0) {
              this.allQueriesHistory.push(...currentPlan.allQueries);
              this.options.observer?.onSearchStart?.(currentPlan.allQueries);
              const searchResults = await search(currentPlan.allQueries, this.config, signal, (links) => {
                  this.options.observer?.onSearchProgress?.(links);
              });
              this.options.observer?.onSearchComplete?.(searchResults.reduce((acc, r) => acc + (r.results?.length || 0), 0));
              logger.info(`[Orchestrator] Search burst completed. Distributing results to researchers...`);
              const researcherLinks = this.distributeResults(currentPlan, searchResults);
              logger.info(`[Orchestrator] Starting ${currentPlan.researchers.length} researchers in parallel...`);
              await this.runResearchersParallel(currentPlan.researchers, researcherLinks, signal);
          } else {
              await this.runResearchersParallel(currentPlan.researchers, new Map(), signal);
          }

          const mustSynthesize = this.currentRound >= maxRounds + MAX_EXTRA_ROUNDS;
          this.plan = currentPlan;
          currentPlan = await this.evaluate(signal, mustSynthesize);

          if (currentPlan.action === 'synthesize') {
              const synthesis = currentPlan.content || this.buildFallbackSynthesis();
              this.options.observer?.onComplete?.(synthesis);
              return synthesis;
          }
      }

      const finalSynthesis = this.buildFallbackSynthesis();
      this.options.observer?.onComplete?.(finalSynthesis);
      return finalSynthesis;

    } catch (error) {
      if (error instanceof Error && error.message === 'Research aborted.') throw error;
      logger.error('[Orchestrator] Run failed:', error);
      this.options.observer?.onError?.(error as Error);
      if (this.reports.size > 0) return this.buildFallbackSynthesis();
      return "Research failed. Check debug logs for details.";
    }
  }

  private buildFallbackSynthesis(): string {
    const reportCount = this.reports.size;
    const roundInfo = this.currentRound > 0 ? ` (up to Round ${this.currentRound})` : "";
    let synthesis = `# Research Findings${roundInfo}\n\n`;
    
    if (reportCount === 0) {
        synthesis += "_No researcher reports were generated before the process stopped._";
    } else {
        synthesis += `*This is an automated synthesis of ${reportCount} individual researcher report(s) gathered before the process was interrupted.*\n\n`;
        synthesis += Array.from(this.reports.entries())
            .map(([id, report]) => `## Researcher ${id}\n\n${report}`)
            .join('\n\n---\n\n');
    }
    
    return synthesis;
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
      return "**Complexity: Level 2 (Normal)**. Conduct a thorough investigation covering multiple angles and sources. Think in terms of a multi-phase investigation: plan Round 1 to broadly map the landscape with parallel specialists, anticipating that subsequent rounds will drill down into specific gaps.";
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
      return `**Level 2 (Normal)** - Thorough, multi-phase investigation.

- **SYNTHESIZE when**: Multiple angles covered with substantial findings across all major topics.
- **DELEGATE when**: ANY gaps remain, missing details, or areas that need deeper exploration. Don't synthesize prematurely.

**IMPORTANT**: Level 2 is designed for multi-round research. You should typically delegate for 2-3 rounds before considering synthesis. Each round adds value and depth to your findings. Be proactive with delegation — default to delegating when in doubt, rather than synthesizing with incomplete findings.`;
    } else {
      return `**Level 3 (Ultra)** - Exhaustive, comprehensive deep-dive.

- **SYNTHESIZE when**: Exhaustively covered across ALL substantial avenues with multiple sources per major topic, no meaningful gaps remain, and you have utilized most of your available round budget (4+ rounds).
- **DELEGATE when**: ANY meaningful gaps, nuanced angles, insufficient source diversity, or areas needing deeper investigation remain. Prioritize thoroughness over efficiency. Lean HEAVILY toward delegation for completeness.

**CRITICAL FOR LEVEL 3**: Do NOT synthesize early. With ${MAX_ROUNDS_LEVEL_3} rounds available, you should typically delegate for 4-5 rounds before considering synthesis. Each round adds breadth and depth. Only synthesis when you have:
1. Multiple rounds of findings (4+ recommended)
2. Diverse sources across all major topics (10+ distinct source domains)
3. Substantial depth per major area (not just surface coverage)
4. No significant gaps that additional rounds would meaningfully address

Be aggressive with delegation. Level 3 is for exhaustive research — use remaining rounds to drill into specialized details, verify findings, or explore nuanced dimensions.`;
    }
  }

  private getRoundPhaseGuidance(maxRounds: number): string {
    const roundRatio = this.currentRound / maxRounds;
    const isLevel2 = this.options.complexity === 2;
    
    if (roundRatio <= 0.5) {
      // Early rounds: be more aggressive with delegation
      return `\n\n---\n\n**Round Phase: EARLY (Round ${this.currentRound} of ${maxRounds})**\n\nYou are in the early phase of research. Be more permissive with delegation:\n- Deploy researchers to broadly map the landscape\n- Don't worry if findings are incomplete — later rounds can fill gaps\n- Focus on breadth and initial exploration\n- Use available researchers to cover distinct angles in parallel`;
    } else if (roundRatio <= 0.8) {
      // Middle rounds: balanced approach
      const guidance = isLevel2 
        ? `**Level 2 Guidance**: You are in the middle phase of Level 2 research. Continue delegating actively — you should aim for 2-3 total rounds before synthesis. Each round adds value and depth to your findings. Don't hold back when there are still meaningful gaps or areas to explore.\n\n- Synthesize only when findings are comprehensive and no significant gaps remain that warrant another round.\n\n` 
        : `You are in the middle phase of research. Apply balanced judgment:\n- Synthesize if you have substantial coverage of the key aspects\n- Delegate for significant gaps or to explore specialized sub-topics\n- Consider depth over breadth at this stage\n- Focus on rounding out incomplete areas`;
      return `\n\n---\n\n**Round Phase: MIDDLE (Round ${this.currentRound} of ${maxRounds})**\n\n${guidance}`;
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
    
    // Hard caps per round - based on actual maximum possible queries
    // Level 1: 2 researchers × 10 queries = 20 maximum
    // Level 2: 3 researchers × 20 queries = 60 maximum  
    // Level 3: 5 researchers × 30 queries = 150 maximum
    const ROUND_HARD_CAP = this.options.complexity === 1 ? 20
                         : this.options.complexity === 2 ? 60
                         : 150;

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
    const startTime = Date.now();
    const linkMap = new Map<string, string[]>();
    if (!plan.researchers) return linkMap;

    plan.researchers.forEach((r) => {
        const ownedLinks: string[] = [];
        const rQueries = new Set(
            r.queries
                .map((q: string) => q.toLowerCase().trim())
                .filter(q => q.length > 0)
        );
        
        // Convert Set to array once per researcher to avoid repeated spreads in the inner loop
        const rQueriesArr = Array.from(rQueries);

        results.forEach((res) => {
            const resQuery = String(res.query ?? '').toLowerCase().trim();
            if (resQuery.length === 0) return;
            
            // Check direct match first (O(1))
            let matched = rQueries.has(resQuery);
            
            // Fallback to fuzzy includes matching (O(Q*L))
            if (!matched) {
                for (let i = 0; i < rQueriesArr.length; i++) {
                    const rq = rQueriesArr[i] as string;
                    if (resQuery.includes(rq) || rq.includes(resQuery)) {
                        matched = true;
                        break;
                    }
                }
            }

            if (matched) {
                const items = res.results ?? [];
                for (let i = 0; i < items.length; i++) {
                    const url = items[i]?.url;
                    if (url) ownedLinks.push(url);
                }
            }
        });
        linkMap.set(String(r.id), Array.from(new Set(ownedLinks)));
    });
    logger.debug(`[Orchestrator] Distributed ${results.length} results in ${Date.now() - startTime}ms`);
    return linkMap;
  }

  private async runResearchersParallel(configs: ResearcherConfig[], linksMap: Map<string, string[]>, signal?: AbortSignal) {
      const queue = [...configs];
      const active = new Set<Promise<void>>();
      const { MAX_CONCURRENT_RESEARCHERS } = this.config;

      while (queue.length > 0 || active.size > 0) {
          if (signal?.aborted) throw new Error("Research aborted.");
          while (active.size < MAX_CONCURRENT_RESEARCHERS && queue.length > 0) {
              if (active.size > 0) await new Promise(resolve => setTimeout(resolve, RESEARCHER_LAUNCH_DELAY_MS));
              const config = queue.shift()!;
              const links = linksMap.get(String(config.id)) || [];
              const p = this.runResearcher(config, links, signal)
                  .catch((err) => {
                      this.options.observer?.onResearcherFailure?.(String(config.id), err.message || String(err));
                      recordResearcherFailure(this.options.sessionId, this.options.researchId, String(config.id));
                  })
                  .finally(() => { active.delete(p); });
              active.add(p);
          }
          if (active.size > 0) {
              await Promise.race(active);
              if (shouldStopResearch(this.options.sessionId, this.options.researchId)) {
                  throw new Error("Research stopped due to excessive infrastructure failures. Multiple researchers failed.");
              }
          }
      }
  }

  private async runResearcher(config: ResearcherConfig, initialLinks: string[], _signal?: AbortSignal): Promise<void> {
    const id = String(config.id);
    this.options.observer?.onResearcherStart?.(id, config.name, config.goal);

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
    const session = await createResearcherSession({
      cwd: this.options.ctx.cwd,
      ctxModel: this.options.model,
      modelRegistry: this.options.ctx.modelRegistry,
      settingsManager: extendedCtx.settingsManager,
      systemPrompt: prompt,
      extensionCtx: this.options.ctx,
      noSearch: true,
      getGlobalState: () => ({ researchId: this.options.researchId } as any),
      onSearchProgress: (links) => {
          this.options.observer?.onResearcherProgress?.(id, `${links} Results`);
      },
    });

    const subscription = session.subscribe((event: AgentSessionEvent) => {
        if (event.type === 'message_end') {
            const msg = event.message as any;
            if (msg?.role !== 'assistant') return;
            const rawUsage = msg.usage;
            if (rawUsage) {
                const parsed = parseTokenUsage(rawUsage);
                const tokens = calculateTotalTokens(parsed);
                const cost: number = (rawUsage as any).cost?.total ?? 0;
                if (tokens > 0 || cost > 0) {
                    this.options.observer?.onResearcherProgress?.(id, undefined, tokens, cost);
                    this.options.observer?.onTokensConsumed?.(tokens, cost);
                }
            }
        } else if (event.type === 'tool_execution_start') {
            this.options.observer?.onResearcherProgress?.(id, `${event.toolName}`);
        } else if (event.type === 'tool_execution_end') {
            this.options.observer?.onResearcherProgress?.(id, `done:${event.toolName}`);
        }
    });

    try {
      let timeoutId: NodeJS.Timeout;
      const timeoutPromise = new Promise<void>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`Researcher ${id} timed out after ${this.config.RESEARCHER_TIMEOUT_MS}ms`)), this.config.RESEARCHER_TIMEOUT_MS);
      });

      try {
        await Promise.race([
          session.prompt(`Topic: ${config.name}\nGoal: ${config.goal}\n\nPerform your research and submit your full report now.`),
          timeoutPromise
        ]);
      } finally {
        clearTimeout(timeoutId!);
      }
      const responseText = ensureAssistantResponse(session, id);
      this.reports.set(`${this.currentRound}.${id}`, responseText);
      this.options.observer?.onResearcherComplete?.(id, responseText);
    } finally {
      subscription();
    }
  }

  private async evaluate(signal?: AbortSignal, mustSynthesize = false): Promise<ResearchPlan> {
      this.options.observer?.onEvaluationStart?.(this.currentRound);
      this.options.observer?.onEvaluationProgress?.('Assessing...');

      const previousQueriesSection = this.plan?.allQueries && this.plan.allQueries.length > 0
          ? `\n### Previous Queries (Sibling Researchers)\n${this.plan.allQueries.map(q => `- ${q}`).join('\n')}\n`
          : '';

      const nextId = this.totalResearchersPlanned + 1;
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

      const reportsText = Array.from(this.reports.entries())
          .map(([id, report]) => {
              const displayId = id.includes('.') ? id.split('.').slice(1).join('.') : id;
              return `### Researcher ${displayId} Report\n\n${report}`;
          })
          .join('\n\n---\n\n');

      const auth = await this.options.ctx.modelRegistry.getApiKeyAndHeaders(this.options.model);
      if (!auth.ok) throw new Error(`Model auth failed: ${auth.error}`);

      const synthOverride = mustSynthesize ? '\n\n**MANDATORY — ABSOLUTE MAXIMUM REACHED**: No further research rounds are permitted. You MUST return `"action": "synthesize"` with a comprehensive synthesis in the `content` field. Do NOT return delegate.' : '';
      const evalUserMessage = `${evalPrompt}${synthOverride}\n\n---\n\nFindings so far:\n\n${reportsText}`;
      
      let text = "";
      for (let evalAttempt = 1; evalAttempt <= 2; evalAttempt++) {
          const response = await completeSimple(this.options.model, {
              messages: [{ role: 'user', content: [{ type: 'text', text: evalUserMessage }], timestamp: Date.now() }]
          }, { apiKey: auth.apiKey, headers: auth.headers, signal });

          const textContent = response.content.find((c): c is TextContent => c.type === 'text');
          text = textContent?.text || "";
          const evalUsageObj = (response as any).usage;
          if (evalUsageObj) {
              const evalUsage = parseTokenUsage(evalUsageObj);
              const tokens = calculateTotalTokens(evalUsage);
              const cost = (evalUsageObj as any).cost?.total ?? 0;
              this.options.observer?.onEvaluationTokens?.(tokens, cost);
              this.options.observer?.onTokensConsumed?.(tokens, cost);
          }
          if (text.trim()) break;
      }

      const extracted = extractJson<ResearchPlan>(text, 'any');
      let plan: ResearchPlan;
      if (extracted.success && extracted.value) {
          plan = extracted.value;
          if (plan.action === 'delegate') {
              if (!Array.isArray(plan.researchers)) plan.action = 'synthesize';
              else {
                  plan.researchers = plan.researchers.filter(r => r && typeof r === 'object' && Array.isArray(r.queries));
                  if (plan.researchers.length === 0) plan.action = 'synthesize';
                  else this.totalResearchersPlanned += plan.researchers.length;
              }
              if (!Array.isArray(plan.allQueries)) plan.allQueries = plan.researchers ? plan.researchers.flatMap(r => r.queries) : [];
              else plan.allQueries = plan.allQueries.filter(q => typeof q === 'string');
          }
          if (plan.action === 'synthesize' && !plan.content) plan = { action: 'synthesize', content: text, researchers: [], allQueries: [] };
      } else {
          plan = { action: 'synthesize', content: text, researchers: [], allQueries: [] };
      }

      this.options.observer?.onEvaluationDecision?.(plan.action as any, plan, this.currentRound);

      return plan.action !== 'synthesize' && Array.isArray(plan.researchers) && plan.researchers.length > 0 && !mustSynthesize 
          ? this.capResearcherQueries(plan) : plan;
  }
}
