/**
 * Planning Service
 *
 * Responsible for generating research plans, coordinating researchers,
 * and managing query generation for multi-round research.
 *
 * This service extracts the planning logic from the orchestrator,
 * making it reusable and testable.
 */

import type { IPlanningService, ResearchPlan, ResearcherConfig, GeneratePlanOptions, GenerateQueriesOptions, UpdatePlanOptions } from './service-interfaces.ts';
import { ServiceLifecycle } from './service-registry.ts';
import { logger } from '../logger.ts';
import { complete, completeSimple, type TextContent, type Message } from '@mariozechner/pi-ai';
import { extractJson } from '../utils/json-utils.ts';
import { injectCurrentDate } from '../utils/inject-date.ts';
import { loadPrompt } from '../utils/prompts.ts';
import { Type } from 'typebox';
import { Value } from 'typebox/value';
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
} from '../constants.ts';
import { estimateTokenCount } from '../types/llm.ts';
import type { LLMResponseMetadata } from '../types/index.ts';
import { parseTokenUsage, calculateTotalTokens } from '../types/llm.ts';
import { metrics } from '../utils/metrics.ts';

// ============================================================================
// TypeBox Schemas for Validation
// ============================================================================

const ResearcherConfigSchema = Type.Object({
    id: Type.Union([Type.String(), Type.Number()]),
    name: Type.String(),
    goal: Type.String(),
    queries: Type.Array(Type.String()),
    historicalLinks: Type.Optional(Type.Array(Type.String()))
});

const ResearchPlanSchema = Type.Object({
    action: Type.Optional(Type.Union([Type.Literal('synthesize'), Type.Literal('delegate')])),
    researchers: Type.Optional(Type.Array(ResearcherConfigSchema)),
    allQueries: Type.Optional(Type.Array(Type.String())),
    content: Type.Optional(Type.String())
});

// ============================================================================
// Planning Service Implementation
// ============================================================================

export class PlanningService implements IPlanningService {
  readonly name = 'PlanningService';
  lifecycle = ServiceLifecycle.UNINITIALIZED as ServiceLifecycle;

  private isInitialized = false;

  // Planning state
  private currentPlan: ResearchPlan | null = null;
  private queryHistory: string[] = [];
  private totalResearchersPlanned: number = 0;

  // Dependencies
  private ctx?: any;

  constructor() {
    // Set initial lifecycle
    this.lifecycle = ServiceLifecycle.UNINITIALIZED;
  }

  /**
   * Initialize the planning service
   */
  async initialize(ctx?: any): Promise<void> {
    if (this.isInitialized) {
      logger.debug(`[${this.name}] Already initialized`);
      return;
    }

    this.lifecycle = ServiceLifecycle.INITIALIZING;
    this.ctx = ctx;
    this.isInitialized = true;
    this.lifecycle = ServiceLifecycle.INITIALIZED;
    logger.log(`[${this.name}] Initialized`);
  }

  /**
   * Get the service name
   */
  getName(): string {
    return this.name;
  }

  /**
   * Check if the service is initialized
   */
  isReady(): boolean {
    return this.isInitialized;
  }

  /**
   * Dispose the service and clean up resources
   */
  async dispose(): Promise<void> {
    this.lifecycle = ServiceLifecycle.DISPOSING;
    this.clearPlanningState();
    this.ctx = undefined;
    this.isInitialized = false;
    this.lifecycle = ServiceLifecycle.DISPOSED;
    logger.log(`[${this.name}] Disposed`);
  }

  // ========================================================================
  // Plan Generation Methods
  // ========================================================================

  /**
   * Generate a research plan
   */
  async generatePlan(options: GeneratePlanOptions): Promise<ResearchPlan> {
    const { query, complexity, model, signal, historicalLinksSection = '' } = options;

    logger.log(`[${this.name}] Generating plan for complexity ${complexity}`);
    metrics.increment('coordinator_plans_total', 1, { complexity: String(complexity) });

    const basePlanningPrompt = injectCurrentDate(loadPrompt('system-coordinator', '..'), 'coordinator')
      .replace(/\{ROOT_QUERY\}/g, query)
      .replace('{MAX_TEAM_SIZE}', this.getTeamSize(complexity).toString())
      .replace('{QUERY_BUDGET}', this.getQueryBudget(complexity).toString())
      .replace('{COMPLEXITY_LABEL}', complexity === 1 ? 'Normal' : complexity === 2 ? 'Deep' : 'Ultra')
      .replace('{COMPLEXITY_GUIDANCE}', this.getComplexityGuidance(complexity, this.getTeamSize(complexity), this.getQueryBudget(complexity)))
      .replace('{{historical_links_section}}', historicalLinksSection);

    const auth = await this.ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) throw new Error(`Model auth failed: ${auth.error}`);

    logger.log(`[${this.name}] Coordinator auth for model ${model.id}: ok=${auth.ok}, hasApiKey=${!!auth.apiKey}`);

    let plan: ResearchPlan | null = null;
    let lastRawPlanText = '';

    for (let attempt = 1; attempt <= 3; attempt++) {
      const retryHint = attempt > 1 ? '\n\n**RETRY**: Your previous JSON was malformed. Ensure you return ONLY valid JSON in a code block.' : '';
      const messages: Message[] = attempt === 1
        ? [{ role: 'user', content: [{ type: 'text', text: `Please plan a research team for: "${query}"` }], timestamp: Date.now() }]
        : [];

      logger.debug(`[${this.name}] Coordinator attempt ${attempt}`);

      const planResponse = await complete(model, {
        systemPrompt: basePlanningPrompt + retryHint,
        messages,
      }, { apiKey: auth.apiKey, headers: auth.headers, signal });

      const planMetadata = planResponse as LLMResponseMetadata;
      if (planMetadata.stopReason === 'error' || planMetadata.stopReason === 'aborted') {
        const apiError = planMetadata.errorMessage || `Model API returned stop reason: ${planMetadata.stopReason}`;
        logger.error(`[${this.name}] Coordinator API call failed (attempt ${attempt}): ${apiError}`);
        metrics.increment('llm_api_errors_total', 1, { component: 'coordinator', stopReason: planMetadata.stopReason });
        throw new Error(`Coordinator model API error: ${apiError}`);
      }

      const textContent = planResponse.content.find((c): c is TextContent => c.type === 'text');
      const rawPlanText = textContent?.text || '';
      lastRawPlanText = rawPlanText;

      logger.debug(`[${this.name}] Coordinator Response:\n${rawPlanText}`);

      try {
        plan = this.parseJsonPlan(rawPlanText);

        if (planResponse.usage) {
          const coordUsage = parseTokenUsage(planResponse.usage);
          const tokens = calculateTotalTokens(coordUsage);
          const cost = planResponse.usage.cost?.total ?? 0;
          metrics.increment('llm_tokens_total', tokens, { component: 'coordinator', complexity: String(complexity) });
          metrics.increment('llm_cost_total', cost, { component: 'coordinator', complexity: String(complexity) });
        }

        metrics.increment('coordinator_plans_total', 1, { complexity: String(complexity), status: 'success' });
        break;
      } catch (err) {
        if (attempt >= 3) {
          logger.warn(`[${this.name}] Coordinator failed JSON parsing after 3 attempts; building fallback plan`);
          metrics.increment('coordinator_plans_total', 1, { complexity: String(complexity), status: 'fallback' });
          plan = this.buildFallbackCoordinatorPlan(lastRawPlanText, query);
          break;
        }
        metrics.increment('coordinator_plans_total', 1, { complexity: String(complexity), status: 'error' });
      }
    }

    if (!plan || !plan.researchers) {
      throw new Error('Coordinator failed to plan any researchers.');
    }

    // Cap team size
    const maxTeamSize = this.getTeamSize(complexity);
    if (plan.researchers.length > maxTeamSize) {
      plan.researchers = plan.researchers.slice(0, maxTeamSize);
      plan.allQueries = plan.researchers.flatMap(r => r.queries);
    }

    // Cap researcher queries
    plan = this.capResearcherQueries(plan, complexity);

    // Update state
    this.currentPlan = plan;
    this.totalResearchersPlanned += plan.researchers?.length ?? 0;

    logger.log(`[${this.name}] Generated plan with ${plan.researchers?.length || 0} researcher(s)`);
    metrics.observe('coordinator_researchers_planned', plan.researchers?.length || 0, { complexity: String(complexity) });

    return plan;
  }

  /**
   * Generate researcher configurations from a plan
   */
  generateResearchers(plan: ResearchPlan, _query: string, _complexity: 1 | 2 | 3): ResearcherConfig[] {
    if (!plan.researchers) {
      return [];
    }

    // Normalize IDs to strings
    const researchers = plan.researchers.map(r => ({
      ...r,
      id: String(r.id),
    }));

    logger.debug(`[${this.name}] Generated ${researchers.length} researcher configs`);
    return researchers;
  }

  /**
   * Generate queries for a researcher
   *
   * Note: In the current implementation, queries are generated as part of the plan
   * generation process. This method is provided for consistency with the interface.
   */
  async generateQueries(options: GenerateQueriesOptions): Promise<string[]> {
    const { researcher } = options;

    // Queries are already part of the researcher config
    return researcher.queries || [];
  }

  /**
   * Update plan for next round (evaluator logic)
   */
  async updatePlanForRound(options: UpdatePlanOptions): Promise<ResearchPlan> {
    const {
      reports,
      round,
      query,
      complexity,
      model,
      signal,
      previousPlan,
      totalResearchersPlanned,
      mustSynthesize = false,
      historicalLinksSection = '',
    } = options;

    logger.log(`[${this.name}] Evaluating for round ${round}`);
    metrics.increment('evaluator_runs_total', 1, { complexity: String(complexity), round: String(round) });

    const previousQueriesSection = previousPlan?.allQueries && previousPlan.allQueries.length > 0
      ? `\n### Previous Queries (Sibling Researchers)\n${previousPlan.allQueries.map(q => `- ${q}`).join('\n')}\n`
      : '';

    const nextId = totalResearchersPlanned + 1;
    const maxTeamSize = this.getTeamSize(complexity);
    const maxRounds = complexity === 1 ? MAX_ROUNDS_LEVEL_1 : complexity === 2 ? MAX_ROUNDS_LEVEL_2 : MAX_ROUNDS_LEVEL_3;

    const evalPrompt = injectCurrentDate(loadPrompt('system-lead-evaluator', '..'), 'evaluator')
      .replace(/\{ROOT_QUERY\}/g, query)
      .replace('{ROUND_NUMBER}', round.toString())
      .replace('{MAX_ROUNDS}', maxRounds.toString())
      .replace('{MAX_TEAM_SIZE}', maxTeamSize.toString())
      .replace('{QUERY_BUDGET}', this.getQueryBudget(complexity).toString())
      .replace('{COMPLEXITY_LABEL}', complexity === 1 ? 'Level 1 (Normal)' : complexity === 2 ? 'Level 2 (Deep)' : 'Level 3 (Ultra)')
      .replace('{COMPLEXITY_GUIDANCE}', this.getEvaluatorComplexityGuidance(complexity))
      .replace('{ROUND_PHASE_GUIDANCE}', this.getRoundPhaseGuidance(round, maxRounds, complexity))
      .replace('{{previous_queries_section}}', previousQueriesSection)
      .replace('{{historical_links_section}}', historicalLinksSection)
      .replace('{NEXT_ID}', `${nextId}`);

    const reportsText = Array.from(reports.entries())
      .map(([id, report]) => {
        const displayId = id.includes('.') ? id.split('.').slice(1).join('.') : id;
        return `### Researcher ${displayId} Report\n\n${report}`;
      })
      .join('\n\n---\n\n');

    const auth = await this.ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) throw new Error(`Model auth failed: ${auth.error}`);

    const synthOverride = mustSynthesize
      ? '\n\n**MANDATORY — ABSOLUTE MAXIMUM REACHED**: No further research rounds are permitted. You MUST return `"action": "synthesize"` with a comprehensive synthesis in the `content` field. Do NOT return delegate.'
      : '';
    const evalUserMessage = `${evalPrompt}${synthOverride}\n\n---\n\nFindings so far:\n\n${reportsText}`;

    let text = '';
    for (let evalAttempt = 1; evalAttempt <= 2; evalAttempt++) {
      const response = await completeSimple(model, {
        messages: [{ role: 'user', content: [{ type: 'text', text: evalUserMessage }], timestamp: Date.now() }]
      }, { apiKey: auth.apiKey, headers: auth.headers, signal });

      const responseMetadata = response as LLMResponseMetadata;
      if (responseMetadata.stopReason === 'error' || responseMetadata.stopReason === 'aborted') {
        const apiError = responseMetadata.errorMessage || `Model API returned stop reason: ${responseMetadata.stopReason}`;
        logger.error(`[${this.name}] Evaluator API call failed (attempt ${evalAttempt}): ${apiError}`);
        metrics.increment('llm_api_errors_total', 1, { component: 'evaluator', stopReason: responseMetadata.stopReason });
        throw new Error(`Evaluator model API error: ${apiError}`);
      }

      const textContent = response.content.find((c): c is TextContent => c.type === 'text');
      text = textContent?.text || '';

      if (response.usage) {
        const evalUsage = parseTokenUsage(response.usage);
        const tokens = calculateTotalTokens(evalUsage);
        const cost = response.usage.cost?.total ?? 0;
        metrics.increment('llm_tokens_total', tokens, { component: 'evaluator', complexity: String(complexity) });
        metrics.increment('llm_cost_total', cost, { component: 'evaluator', complexity: String(complexity) });
      }

      if (text.trim()) break;
    }

    let extracted = extractJson<ResearchPlan>(text, 'any');
    const estimatedTokens = estimateTokenCount(evalUserMessage) + estimateTokenCount(text);
    const correctionSafe = estimatedTokens < 100_000;

    if (!extracted.success && text.trim() && correctionSafe) {
      logger.warn(`[${this.name}] Evaluator JSON parse failed; attempting self-correction`);
      const correctionMsg = `${evalUserMessage}\n\n---\n\nYOUR PREVIOUS RESPONSE (not valid JSON):\n${text}\n\n---\n\nReturn ONLY a valid JSON object now. No prose before or after.`;
      const corrResponse = await completeSimple(model, {
        messages: [{ role: 'user', content: [{ type: 'text', text: correctionMsg }], timestamp: Date.now() }]
      }, { apiKey: auth.apiKey, headers: auth.headers, signal });
      const corrText = corrResponse.content.find((c): c is TextContent => c.type === 'text');
      if (corrText?.text?.trim()) {
        extracted = extractJson<ResearchPlan>(corrText.text, 'any');
        if (extracted.success) text = corrText.text;
      }
    }

    let plan: ResearchPlan;
    if (extracted.success && extracted.value) {
      plan = extracted.value;
      if (plan.action === 'delegate') {
        if (!Array.isArray(plan.researchers)) {
          plan.action = 'synthesize';
        } else {
          plan.researchers = plan.researchers.filter(r => r && typeof r === 'object' && Array.isArray(r.queries));
          if (plan.researchers.length === 0) {
            plan.action = 'synthesize';
          } else {
            // We'll update totalResearchersPlanned in the orchestrator
          }
        }
        plan.allQueries = (plan.researchers ?? []).flatMap(r => r.queries);
      }
      if (plan.action === 'synthesize' && !plan.content) {
        plan = { action: 'synthesize', content: text, researchers: [], allQueries: [] };
      }
    } else {
      plan = { action: 'synthesize', content: text, researchers: [], allQueries: [] };
    }

    if (mustSynthesize && plan.action !== 'synthesize') {
      logger.warn(`[${this.name}] Evaluator tried to delegate despite reaching max rounds; forcing synthesis.`);
      plan.action = 'synthesize';
    }

    this.currentPlan = plan;

    return plan.action !== 'synthesize' && Array.isArray(plan.researchers) && plan.researchers.length > 0 && !mustSynthesize
      ? this.capResearcherQueries(plan, complexity)
      : plan;
  }

  // ========================================================================
  // Query History Methods
  // ========================================================================

  /**
   * Get the query history
   */
  getQueryHistory(): string[] {
    return [...this.queryHistory];
  }

  /**
   * Add queries to history
   */
  addToQueryHistory(queries: string[]): void {
    this.queryHistory.push(...queries);
    logger.debug(`[${this.name}] Added ${queries.length} queries to history (total: ${this.queryHistory.length})`);
  }

  // ========================================================================
  // State Management Methods
  // ========================================================================

  /**
   * Get the current plan
   */
  getCurrentPlan(): ResearchPlan | null {
    return this.currentPlan;
  }

  /**
   * Get the total number of researchers planned so far
   */
  getTotalResearchersPlanned(): number {
    return this.totalResearchersPlanned;
  }

  /**
   * Clear all planning state
   */
  clearPlanningState(): void {
    this.currentPlan = null;
    this.queryHistory = [];
    this.totalResearchersPlanned = 0;
    logger.debug(`[${this.name}] Cleared planning state`);
  }

  // ========================================================================
  // Helper Methods
  // ========================================================================

  /**
   * Get the max team size for a complexity level
   */
  getTeamSize(complexity: 1 | 2 | 3): number {
    return complexity === 1 ? MAX_TEAM_SIZE_LEVEL_1
      : complexity === 2 ? MAX_TEAM_SIZE_LEVEL_2
      : MAX_TEAM_SIZE_LEVEL_3;
  }

  /**
   * Get the query budget per researcher for a complexity level
   */
  getQueryBudget(complexity: 1 | 2 | 3): number {
    return complexity === 1 ? MAX_QUERIES_PER_RESEARCHER_LEVEL_1
      : complexity === 2 ? MAX_QUERIES_PER_RESEARCHER_LEVEL_2
      : MAX_QUERIES_PER_RESEARCHER_LEVEL_3;
  }

  /**
   * Get complexity-specific guidance for the coordinator
   */
  getComplexityGuidance(complexity: 1 | 2 | 3, maxTeamSize: number, queryBudget: number): string {
    if (complexity === 1) {
      return '**Complexity: Level 1 (Normal)**. Conduct a thorough, well-rounded investigation of the topic covering the primary angles with adequate citations. Plan multiple researchers for distinct aspects and aim for solid multi-source coverage.';
    } else if (complexity === 2) {
      return `**Complexity: Level 2 (Deep)**. Conduct a thorough investigation covering multiple angles and sources with comprehensive citations. Think in terms of a multi-phase investigation: plan Round 1 to map the landscape with specialized researchers, anticipating that subsequent rounds will cover remaining gaps. Scale your team (up to ${maxTeamSize}) based on topic scope.`;
    } else {
      return `**Complexity: Level 3 (Ultra)**. Perform an exhaustive, deep-dive research effort, leaving no stone unturned. **IMPORTANT**: Plan aggressively for multiple research rounds with comprehensive citation throughout. In your initial planning, deploy the maximum number of researchers (${maxTeamSize}) and fully utilize each researcher's query budget (${queryBudget}). Think in terms of a multi-phase investigation: plan Round 1 to broadly map the landscape with parallel specialists, anticipating that subsequent rounds will cover remaining gaps. Don't hold back — leverage all available researchers and queries in Round 1 to maximize initial coverage and source diversity.

**ULTRA-SPECIFICITY MANDATE**: Level 3 demands granular, exhaustive detail on every fact that benefits from it — exact figures, dates, names, mechanisms, edge cases, historical context, technical specifics, and primary-source precision. Plan dedicated researchers for drilling into the ultra-specific dimensions of any finding where greater detail adds value. Subsequent rounds SHOULD be delegated specifically to pursue these ultra-specific angles: exact statistics, precise chronologies, technical minutiae, named individuals and their specific roles, verbatim data, and any other granular details that enrich the overall picture.`;
    }
  }

  /**
   * Get complexity-specific guidance for the evaluator
   */
  getEvaluatorComplexityGuidance(complexity: 1 | 2 | 3): string {
    if (complexity === 1) {
      return `**Level 1 (Normal)** - Thorough, well-rounded investigation with solid multi-source coverage.

- **SYNTHESIZE when**: The primary topic is covered from multiple angles with evidence from diverse sources and no significant gaps remain that would prevent a complete answer.
- **DELEGATE when**: Coverage is incomplete, important angles are missing, or additional sources would meaningfully strengthen the findings.

Use both available rounds when the topic warrants it. Delegate for a second round if the initial findings are narrow, lack source diversity, or leave key angles unexplored. The goal is thorough coverage, not just bare minimum facts.`;
    } else if (complexity === 2) {
      return `**Level 2 (Deep)** - Thorough, multi-phase investigation with comprehensive citations.

- **SYNTHESIZE when**: Multiple angles covered with substantial findings across all major topics, diverse sources cited throughout, and no significant gaps in coverage.
- **DELEGATE when**: ANY gaps remain in major topics, insufficient source diversity, missing details, or areas that need deeper exploration. Don't synthesize prematurely.

**IMPORTANT**: Level 2 is designed for multi-round research. You should typically delegate for 2-3 rounds before considering synthesis. Each round adds value, depth, and citation diversity to your findings. Prioritize source coverage — aim for multiple authoritative references per topic. Be proactive with delegation — default to delegating when in doubt, rather than synthesizing with incomplete findings or insufficient citations.`;
    } else {
      return `**Level 3 (Ultra)** - Exhaustive, comprehensive deep-dive with extensive citations.

- **SYNTHESIZE when**: Exhaustively covered across ALL substantial avenues with multiple diverse sources per major topic, comprehensive citations throughout, no meaningful gaps remain, and you have utilized most of your available round budget (4+ rounds).
- **DELEGATE when**: ANY meaningful gaps, nuanced angles, insufficient source diversity, inadequate citations for existing findings, or areas needing deeper investigation remain. Prioritize thoroughness and citation richness over efficiency. Lean HEAVILY toward delegation for completeness.

**CRITICAL FOR LEVEL 3**: Do NOT synthesize early. With ${MAX_ROUNDS_LEVEL_3} rounds available, you should typically delegate for 4-5 rounds before considering synthesis. Each round adds breadth, depth, and citation diversity. Only synthesis when you have:
1. Multiple rounds of findings (4+ recommended)
2. Diverse sources across all major topics (10+ distinct source domains minimum)
3. Substantial depth per major area (not just surface coverage)
4. Comprehensive citations throughout (every major claim supported by multiple sources)
5. No significant gaps that additional rounds would meaningfully address

Be aggressive with delegation. Level 3 is for exhaustive research — use remaining rounds to drill into specialized details, verify findings with additional sources, or explore nuanced dimensions.

**ULTRA-SPECIFICITY MANDATE**: For every fact, finding, or topic area where greater granularity adds value, delegate additional researchers to pursue it. This includes: exact figures and statistics, precise dates and timelines, technical mechanisms and processes, named individuals and their specific contributions, primary-source verbatim data, edge cases, exceptions, and any dimension where surface-level coverage would leave the reader with unanswered "but exactly how/when/who/what" questions. If a finding is interesting, assume the ultra-specific details are equally interesting and worth a dedicated delegation round.`;
    }
  }

  /**
   * Get round phase guidance based on current round and max rounds
   */
  getRoundPhaseGuidance(currentRound: number, maxRounds: number, complexity: 1 | 2 | 3): string {
    const roundRatio = currentRound / maxRounds;

    if (roundRatio <= 0.5) {
      // Early rounds
      if (complexity === 3) {
        return `\n\n---\n\n**Round Phase: EARLY (Round ${currentRound} of ${maxRounds}) — Level 3 Ultra**\n\n**DELEGATE. Do not synthesize.** You are in the early phase of an exhaustive research effort with ${maxRounds} rounds available.\n- Deploy the MAXIMUM number of researchers across completely distinct angles — leave no major dimension unmapped\n- Fully saturate each researcher's query budget; partial budgets waste available depth\n- Expect to delegate for at least ${Math.ceil(maxRounds * 0.7)} rounds before synthesis is even considered\n- Treat every round as mandatory — this phase exists to establish the broadest possible foundation of sources and findings\n- Do NOT synthesize under any circumstances this early`;
      }
      // Level 1 / Level 2 early
      return `\n\n---\n\n**Round Phase: EARLY (Round ${currentRound} of ${maxRounds})**\n\nYou are in the early phase of research. Be more permissive with delegation:\n- Deploy researchers to broadly map the landscape\n- Don't worry if findings are incomplete — later rounds can fill gaps\n- Focus on breadth and initial exploration\n- Use available researchers to cover distinct angles in parallel`;
    } else if (roundRatio <= 0.8) {
      // Middle rounds
      if (complexity === 3) {
        return `\n\n---\n\n**Round Phase: MIDDLE (Round ${currentRound} of ${maxRounds}) — Level 3 Ultra**\n\n**STRONGLY PREFER DELEGATION.** You are in the middle phase of exhaustive research.\n- With ${maxRounds - currentRound} rounds remaining, you have substantial capacity — use it\n- Delegate to sibling researchers covering angles not yet fully explored, deeper sub-topics of what has been found, or cross-cutting themes that span multiple earlier findings\n- Further rounds should drill into specialist detail, verify findings with additional independent sources, and surface nuanced dimensions of the topic\n- Synthesize ONLY if: you have 4+ rounds of findings, 10+ distinct source domains, every major claim is multi-source verified, and you genuinely cannot identify gaps that another round would address\n- If you can name even one meaningful unexplored angle — DELEGATE`;
      }
      if (complexity === 2) {
        return `\n\n---\n\n**Round Phase: MIDDLE (Round ${currentRound} of ${maxRounds})**\n\n**Level 2 (Deep) Guidance**: You are in the middle phase of deep research. Continue delegating actively — you should aim for 2-3 total rounds before synthesis. Each round adds value and depth to your findings. Don't hold back when there are still meaningful gaps or areas to explore.\n\n- Synthesize only when findings are comprehensive and no significant gaps remain that warrant another round.\n\n`;
      }
      // Level 1 middle
      return `\n\n---\n\n**Round Phase: MIDDLE (Round ${currentRound} of ${maxRounds})**\n\nYou are in the middle phase of research. Apply balanced judgment:\n- Synthesize if you have substantial coverage of the key aspects\n- Delegate for significant gaps or to explore specialized sub-topics\n- Consider depth over breadth at this stage\n- Focus on rounding out incomplete areas`;
    } else {
      // Late rounds
      if (complexity === 3) {
        return `\n\n---\n\n**Round Phase: LATE (Round ${currentRound} of ${maxRounds}) — Level 3 Ultra**\n\nYou are in the late phase of exhaustive research. Still prefer delegation over synthesis:\n- Delegate if ANY meaningful dimension remains under-sourced, under-verified, or shallowly covered\n- Use remaining rounds to pursue specialist sub-topics, cross-verify key claims with independent sources, or explore nuanced angles surfaced by earlier rounds\n- Delegate to sibling researchers that go deeper into the most critical findings so far, not just broader coverage\n- Synthesize only when you have genuinely exhausted meaningful research avenues AND have comprehensive multi-source coverage across all major areas`;
      }
      // Level 1 / Level 2 late
      return `

---

**Round Phase: LATE (Round ${currentRound} of ${maxRounds})**

You are in the late phase of research. Set a higher threshold for delegation:
- Synthesize if the core question is answerable with current findings
- Delegate only for CRITICAL gaps that cannot be resolved from existing findings
- Avoid delegating for minor details or marginal improvements
- Focus on delivering a complete, coherent response`;
    }
  }

  /**
   * Cap researcher queries to stay within budget
   */
  capResearcherQueries(plan: ResearchPlan, complexity: 1 | 2 | 3): ResearchPlan {
    const budget = this.getQueryBudget(complexity);

    // Hard caps per round - based on actual maximum possible queries
    // Level 1: 2 researchers × 10 queries = 20 maximum
    // Level 2: 3 researchers × 20 queries = 60 maximum
    // Level 3: 5 researchers × 30 queries = 150 maximum
    const ROUND_HARD_CAP = complexity === 1 ? 20
      : complexity === 2 ? 60
      : 150;

    if (!plan.researchers) return plan;

    // 1. Normalize IDs to strings and cap individual researchers
    // CRITICAL: Only keep researchers with non-empty queries to guarantee search results
    plan.researchers = plan.researchers
      .filter(r => r && typeof r === 'object' && Array.isArray(r.queries) && r.queries.length > 0)
      .map(r => {
        const normalized = { ...r, id: String(r.id) };
        if (normalized.queries.length > budget) {
          logger.warn(`[${this.name}] Capping researcher ${normalized.id} queries: ${normalized.queries.length} → ${budget}`);
          normalized.queries = normalized.queries.slice(0, budget);
        }
        return normalized;
      });

    // 2. Enforce global round budget
    let totalQueries = plan.researchers.reduce((sum, r) => sum + r.queries.length, 0);
    if (totalQueries > ROUND_HARD_CAP) {
      logger.warn(`[${this.name}] Total round queries (${totalQueries}) exceeds hard cap (${ROUND_HARD_CAP}). Trimming...`);
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

  /**
   * Parse JSON from LLM response into ResearchPlan
   */
  parseJsonPlan(text: string): ResearchPlan {
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
        logger.warn(`[${this.name}] Plan validation failed: ${errors.map(e => String(e.message)).join(', ')}`);
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

  /**
   * Build a fallback coordinator plan when LLM fails
   */
  buildFallbackCoordinatorPlan(_rawText: string, query: string): ResearchPlan {
    const words = query.split(/\s+/).slice(0, 6).join(' ');
    const queries = [query, `${words} overview`, `${words} latest`].filter(Boolean).slice(0, 3);
    logger.warn(`[${this.name}] Coordinator fallback: single researcher for "${query.slice(0, 80)}"`);
    return {
      action: 'delegate',
      researchers: [{ id: '1', name: 'General Researcher', goal: `Research the following query comprehensively: ${query}`, queries }],
      allQueries: queries,
    };
  }
}