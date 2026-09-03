/**
 * Planning Utilities
 *
 * Helper functions for planning service
 */

import { logger } from '../logger.ts';
import { Value } from 'typebox/value';
import { extractJson } from '../utils/json-utils.ts';
import type { ResearchPlan, ResearcherConfig } from './interfaces/planning-interfaces.ts';
import { ResearchPlanSchema } from './interfaces/planning-interfaces.ts';
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

/**
 * Get the max team size for a complexity level
 */
export function getTeamSize(complexity: 1 | 2 | 3): number {
  return complexity === 1 ? MAX_TEAM_SIZE_LEVEL_1
    : complexity === 2 ? MAX_TEAM_SIZE_LEVEL_2
    : MAX_TEAM_SIZE_LEVEL_3;
}

/**
 * Get the query budget per researcher for a complexity level
 */
export function getQueryBudget(complexity: 1 | 2 | 3): number {
  return complexity === 1 ? MAX_QUERIES_PER_RESEARCHER_LEVEL_1
    : complexity === 2 ? MAX_QUERIES_PER_RESEARCHER_LEVEL_2
    : MAX_QUERIES_PER_RESEARCHER_LEVEL_3;
}

/**
 * Get the max rounds for a complexity level
 */
export function getMaxRounds(complexity: 1 | 2 | 3): number {
  return complexity === 1 ? MAX_ROUNDS_LEVEL_1
    : complexity === 2 ? MAX_ROUNDS_LEVEL_2
    : MAX_ROUNDS_LEVEL_3;
}

/**
 * Get complexity-specific guidance for the coordinator
 */
export function getComplexityGuidance(complexity: 1 | 2 | 3, maxTeamSize: number, queryBudget: number): string {
  if (complexity === 1) {
    return '**Complexity: Level 1 (Normal)**. Conduct a thorough, well-rounded investigation of the topic covering the primary angles with adequate citations. **Plan ONLY Round 1** — a single comprehensive round. **Default to a single researcher** for most Level 1 topics — one focused researcher can handle the majority of normal-complexity queries efficiently. Use 2 researchers only when the topic clearly spans two distinct, non-overlapping domains that benefit from parallel investigation. This is a ONE-SHOT effort: plan Round 1 as if it is the only round, because it should be. Only Level 2 or Level 3 research should involve multiple rounds.';
  } else if (complexity === 2) {
    return `**Complexity: Level 2 (Deep)**. **ONLY for HIGH/EXTREME research needs.** Level 2 should be reserved for topics that clearly require deeper investigation than a single comprehensive round can provide. **Plan ONLY Round 1** — a thorough, well-structured first round. Subsequent rounds are reactive and only delegated when Round 1 findings reveal clear gaps that warrant deeper or broader coverage. Do not pre-plan multiple rounds; delegate follow-ups only when Round 1 demonstrates genuine need.

Scale your team (1-${maxTeamSize}) based on topic scope — not every round needs the full team. A single well-targeted researcher for follow-up gaps is usually sufficient.`;
  } else {
    return `**Complexity: Level 3 (Ultra)**. Perform an exhaustive, deep-dive research effort, leaving no stone unturned. **Plan ONLY Round 1** — make it comprehensive, deploying up to ${maxTeamSize} researchers with full query budgets (${queryBudget} each) covering all major dimensions of the topic. Round 1 should aim to cover the full scope comprehensively.

Follow-up rounds are purely reactive — they only happen when Round 1 findings reveal gaps that warrant deeper diving into specific dimensions or broader exploration of adjacent topics. Do NOT pre-plan multiple rounds; let the findings drive the need. Think of Round 1 as the comprehensive landscape map, with follow-up rounds as targeted expeditions into areas that need more detail.

**ULTRA-SPECIFICITY MANDATE**: Level 3 demands granular, exhaustive detail on every fact that benefits from it — exact figures, dates, names, mechanisms, edge cases, historical context, technical specifics, and primary-source precision. Plan dedicated researchers for drilling into the ultra-specific dimensions of any finding where greater detail adds value.`;
  }
}

/**
 * Get complexity-specific guidance for the evaluator.
 *
 * `researchRounds` is the number of rounds that can still DELEGATE — the caller's
 * live, steering-extended budget minus the terminal synthesis-only iteration. It is
 * a parameter rather than a table lookup because this text sits in the same prompt
 * as the round-phase guidance, which is already phrased against that number: a
 * hardcoded per-level constant here told a Level 3 router it had "3 rounds
 * available" three lines above "Round 1 of 2", and put the two apart by a further
 * round whenever steering extended the budget. Every round count the model is shown
 * must come from the same source.
 */
export function getEvaluatorComplexityGuidance(complexity: 1 | 2 | 3, researchRounds: number): string {
  const rounds = Math.max(1, Math.floor(researchRounds));
  // One line, correct in both directions. At a budget of one there is no follow-up to
  // recommend and saying otherwise invites the model to defer to a round it will never
  // get; above one, the encouragement to use the budget is the point.
  const budgetLine = rounds === 1
    ? 'This run has ONE research round, and it has already happened — there is no follow-up round to defer to, so decide on what is in front of you.'
    : `This run has ${rounds} research rounds in total; lean toward using them rather than finishing early.`;
  if (complexity === 1) {
    return `**Level 1 (Normal)** - Thorough, well-rounded investigation with solid multi-source coverage.

- **SYNTHESIZE when**: The primary topic is covered from multiple angles with evidence from diverse sources and no significant gaps remain that would prevent a complete answer.
- **DELEGATE when**: Coverage is incomplete, important angles are missing, or additional sources would meaningfully strengthen the findings.

**DEFAULT PATH**: Synthesize after Round 1 if the researcher produced solid coverage of the core topic. **Level 1 should almost always be a single round** — only delegate a second round when Round 1 clearly missed important angles or lacks source diversity. A single researcher is the default for Level 1 follow-up rounds — only use 2 researchers if the remaining gaps clearly span two distinct domains. Level 2 research escalation should be reserved for truly high/extreme research needs only.`;
  } else if (complexity === 2) {
    return `**Level 2 (Deep)** - Thorough, multi-phase investigation with comprehensive citations.

- **SYNTHESIZE when**: You are confident the research is genuinely complete. This means multiple angles covered with substantial findings across all major topics, diverse sources cited throughout, and no significant gaps in coverage.
- **DELEGATE when**: ANY gaps remain in major topics, insufficient source diversity, missing details, or areas that need deeper exploration. Don't synthesize prematurely.

**DEFAULT PATH: When in doubt, DELEGATE**. It is better to conduct additional research rounds than to synthesize with incomplete findings. Level 2 is designed for multi-round research. Each round adds depth and citation diversity — but do not delegate unnecessarily. Synthesize after Round 1 ONLY if the researcher produced comprehensive coverage of the topic with good source diversity; if it has any gaps, delegate. ${budgetLine} Scale researcher count to match the gaps — focused gaps may only need 1 researcher, while broad gaps benefit from the full team.`;
  } else {
    return `**Level 3 (Ultra)** - Exhaustive, comprehensive deep-dive with extensive citations.

- **SYNTHESIZE when**: You are confident the research is genuinely and exhaustively complete. This means exhaustively covered across ALL substantial avenues with multiple diverse sources per major topic, comprehensive citations throughout, and no meaningful gaps remain.
- **DELEGATE when**: ANY meaningful gaps, nuanced angles, insufficient source diversity, inadequate citations, or areas needing deeper investigation remain.

**DEFAULT PATH: When in doubt, DELEGATE**. It is better to conduct additional research rounds than to synthesize with incomplete findings. ${budgetLine} Be generous with follow-up delegation. Each round adds breadth, depth, and citation diversity. Delegate for follow-up whenever remaining gaps or under-explored angles exist, even if progress has been good. Only synthesize when you have genuinely comprehensive coverage across all major areas with no meaningful gaps that another round would address.

**ULTRA-SPECIFICITY MANDATE**: For every fact, finding, or topic area where greater granularity adds value, delegate additional researchers to pursue it. This includes: exact figures and statistics, precise dates and timelines, technical mechanisms, named individuals and their specific contributions, primary-source verbatim data, edge cases, and any dimension where surface-level coverage would leave the reader with unanswered questions.`;
  }
}

/**
 * Get round phase guidance based on current round and max rounds
 */
export function getRoundPhaseGuidance(currentRound: number, maxRounds: number, complexity: 1 | 2 | 3, maxTeamSize: number): string {
  const roundRatio = currentRound / maxRounds;

  if (roundRatio <= 0.5) {
    // Early rounds
    if (complexity === 3) {
      return `\n\n---\n\n**Round Phase: EARLY (Round ${currentRound} of ${maxRounds}) — Level 3 Ultra**\n\n**DELEGATE. Do not synthesize.** You are in the early phase of an exhaustive research effort with ${maxRounds} rounds available.\n- Deploy up to ${maxTeamSize} researchers across completely distinct angles — leave no major dimension unmapped\n- Not every round needs all ${maxTeamSize} researchers — use as many as the remaining gaps require\n- Fully saturate each researcher's query budget; partial budgets waste available depth\n- This phase exists to establish the broadest possible foundation of sources and findings\n- Do NOT synthesize under any circumstances this early`;
    }
    // Level 1 / Level 2 early
    return `\n\n---\n\n**Round Phase: EARLY (Round ${currentRound} of ${maxRounds})**\n\nYou are in the early phase of research. Be more permissive with delegation:\n- Deploy researchers to broadly map the landscape\n- Not every round needs all ${maxTeamSize} researchers — use as many as the remaining gaps require\n- Don't worry if findings are incomplete — later rounds can fill gaps\n- Focus on breadth and initial exploration\n- Use available researchers to cover distinct angles in parallel`;
  } else if (roundRatio <= 0.8) {
    // Middle rounds
    if (complexity === 3) {
      return `\n\n---\n\n**Round Phase: MIDDLE (Round ${currentRound} of ${maxRounds}) — Level 3 Ultra**\n\n**PREFER DELEGATION.** You are in the middle phase of exhaustive research — use your remaining rounds.\n- Not every round needs all ${maxTeamSize} researchers — use as many as the remaining gaps require\n- With ${maxRounds - currentRound} round(s) remaining, delegate to cover angles not yet fully explored, drill into deeper sub-topics, or verify findings with additional sources\n- Be generous with follow-up — delegate whenever gaps or under-explored angles exist\n- Synthesize ONLY when you genuinely cannot identify gaps that another round would address\n- If you can name even one meaningful unexplored angle — DELEGATE`;
    }
    if (complexity === 2) {
      return `\n\n---\n\n**Round Phase: MIDDLE (Round ${currentRound} of ${maxRounds})**\n\n**Level 2 (Deep) Guidance**: You are in the middle phase of deep research. Continue delegating when there are still meaningful gaps or areas to explore.\n\n- Not every round needs all ${maxTeamSize} researchers — use as many as the remaining gaps require\n- Synthesize only when findings are comprehensive and no significant gaps remain that warrant another round\n- Default to delegating when in doubt\n\n`;
    }
    // Level 1 middle
    return `\n\n---\n\n**Round Phase: MIDDLE (Round ${currentRound} of ${maxRounds})**\n\nYou are in the middle phase of research. Apply balanced judgment:\n- Not every round needs all ${maxTeamSize} researchers — use as many as the remaining gaps require\n- Synthesize if you have substantial coverage of the key aspects\n- Delegate for significant gaps or to explore specialized sub-topics\n- Consider depth over breadth at this stage\n- Focus on rounding out incomplete areas`;
  } else {
    // Late rounds
    if (complexity === 3) {
      return `\n\n---\n\n**Round Phase: LATE (Round ${currentRound} of ${maxRounds}) — Level 3 Ultra**\n\nYou are in the late phase of exhaustive research. Still prefer delegation — use your remaining rounds.\n- Not every round needs all ${maxTeamSize} researchers — use as many as the remaining gaps require\n- Delegate if ANY meaningful dimension remains under-sourced, under-verified, or shallowly covered\n- Use remaining rounds to drill into specialist detail, verify findings, or explore nuanced angles surfaced by earlier rounds\n- Synthesize only when you have genuinely exhausted meaningful research avenues AND have comprehensive multi-source coverage across all major areas`;
    }
    // Level 1 / Level 2 late
    return `

---

**Round Phase: LATE (Round ${currentRound} of ${maxRounds})**

You are in the late phase of research. Set a higher threshold for delegation:
- Not every round needs all ${maxTeamSize} researchers — use as many as the remaining gaps require\n- Synthesize if the core question is answerable with current findings
- Delegate only for CRITICAL gaps that cannot be resolved from existing findings
- Avoid delegating for minor details or marginal improvements
- Focus on delivering a complete, coherent response`;
  }
}

/**
 * Parse JSON from LLM response into ResearchPlan
 */
export function parseJsonPlan(text: string): ResearchPlan {
  // Unwrap a doubly-encoded payload up front. Some models (observed: deepseek-v4-flash
  // via OpenRouter, 2026-09-02) call the submit_plan tool with the plan JSON-encoded
  // INSIDE a string argument, so the toolCall re-serialization path hands us a
  // doubly-encoded payload — extractJson('object') then fails outright with the
  // misleading "No valid JSON found" instead of exposing the plan it contains.
  let normalized = text.trim();
  if (normalized.startsWith('"')) {
    try {
      const unwrapped = JSON.parse(normalized);
      if (typeof unwrapped === 'string') normalized = unwrapped.trim();
    } catch { /* not a JSON string literal — extract below reports the real state */ }
  }

  const result = extractJson<unknown>(normalized, 'object');
  if (!result.success || !result.value) {
    const preview = text.length > 100 ? text.slice(0, 100) + '...' : text;
    throw new Error(`Failed to extract valid JSON plan: ${result.error}. Raw response preview: "${preview}"`);
  }

  const candidate: unknown = result.value;

  // Normalize explicit nulls for OPTIONAL fields. The schema treats researchers /
  // allQueries / content / title / action / fallback as optional, but models
  // frequently emit them as null (observed live 2026-09-02: a "research-complete"
  // router answer with researchers:null, allQueries:null). With TypeBox 1.3.7 a null
  // optional field makes Value.Errors report a ROOT error (path undefined, message
  // "must be object") instead of pointing at the field — reproducing exactly the
  // "Plan validation failed: undefined: must be object" seen in the logs — and the
  // plan fell into the costly agentic-repair path even though the model's decision
  // (synthesize) was perfectly valid. Dropping the key is exactly what the model meant.
  if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
    for (const key of ['researchers', 'allQueries', 'content', 'title', 'action', 'fallback'] as const) {
      if ((candidate as Record<string, unknown>)[key] === null) {
        delete (candidate as Record<string, unknown>)[key];
      }
    }
  }

  // Robust validation using TypeBox
  try {
    // 1. Convert/Coerce values (e.g. string numbers to numbers, single values to arrays if possible)
    const coerced = Value.Convert(ResearchPlanSchema, candidate);
    
    // 2. Validate against schema
    if (!Value.Check(ResearchPlanSchema, coerced)) {
      const errors = [...Value.Errors(ResearchPlanSchema, coerced)];
      const errorMsg = errors.map((e: any) => `${e.path}: ${e.message}`).join(', ');
      // If validation fails, we throw to satisfy tests and ensure system integrity
      throw new Error(`Plan validation failed: ${errorMsg}`);
    }

    const plan = coerced as ResearchPlan;

    // Invariant: only a 'synthesize' response may omit researchers. Every other action
    // (delegate, or an unset action that defaults to delegation downstream) must carry a
    // researchers array to act on. The schema relaxes `researchers` to optional so a valid
    // synthesis ({ action, content }) is accepted instead of being thrown into the costly
    // agentic-repair path; this guard preserves the delegate-must-have-researchers rule.
    if (plan.action !== 'synthesize' && plan.researchers === undefined) {
      throw new Error('Plan validation failed: /researchers: a non-synthesize plan must include a researchers array');
    }

    // 3. Post-processing
    if (plan.researchers) {
      plan.researchers.forEach((r) => {
        // Coerce IDs to strings for consistency
        r.id = String(r.id);
      });
    }

    return plan;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Plan validation error: ${msg}`, { cause: err });
  }
}

/**
 * Build a fallback coordinator plan when LLM fails
 */
export function buildFallbackCoordinatorPlan(serviceName: string, _rawText: string, query: string): ResearchPlan {
  const words = query.split(/\s+/).slice(0, 6).join(' ');
  const queries = [query, `${words} overview`, `${words} latest`].filter(Boolean).slice(0, 3);
  logger.warn(`[${serviceName}] Coordinator fallback: single researcher for "${query.slice(0, 80)}"`);
  return {
    action: 'delegate',
    // Marks this as engine-generated after unusable model output, so UI surfaces can
    // say "degraded" instead of presenting one researcher as the model's considered plan.
    fallback: true,
    researchers: [{ id: '1', name: 'General Researcher', goal: `Research the following query comprehensively: ${query}`, queries }],
    allQueries: queries,
  };
}

/**
 * Cap researcher queries to stay within budget
 */
export function capResearcherQueries(plan: ResearchPlan, complexity: 1 | 2 | 3, serviceName: string): ResearchPlan {
  const budget = getQueryBudget(complexity);

  // Hard caps per round - based on actual maximum possible queries
  // Level 1: 2 researchers x 10 queries = 20 maximum
  // Level 2: 3 researchers x 15 queries = 45 maximum
  // Level 3: 5 researchers x 20 queries = 100 maximum
  const ROUND_HARD_CAP = complexity === 1 ? 20
    : complexity === 2 ? 45
    : 100;

  if (!plan.researchers) return plan;

  // 1. Normalize IDs to strings and cap individual researchers
  // CRITICAL: Only keep researchers with non-empty queries to guarantee search results
  const maxTeam = getTeamSize(complexity);
  plan.researchers = plan.researchers
    .filter(r => r && typeof r === 'object' && Array.isArray(r.queries) && r.queries.length > 0)
    .slice(0, maxTeam)
    .map(r => {
      const normalized = { ...r, id: String(r.id) };
      if (normalized.queries.length > budget) {
        logger.warn(`[${serviceName}] Capping researcher ${normalized.id} queries: ${normalized.queries.length} → ${budget}`);
        normalized.queries = normalized.queries.slice(0, budget);
      }
      return normalized;
    });

  // 1b. Enforce unique researcher IDs within the round. Reports are keyed `${round}.${id}`
  // and search links by String(id); two researchers sharing an id (the LLM emitting `1.1`
  // twice, or `1` and "1") collide last-writer-wins — both run but one's findings are silently
  // dropped. Renumber collisions so every launched researcher's report is retained.
  const seenIds = new Set<string>();
  for (const r of plan.researchers) {
    const rid = String(r.id);
    if (!seenIds.has(rid)) { seenIds.add(rid); continue; }
    let n = 2;
    let candidate = `${rid}-${n}`;
    while (seenIds.has(candidate)) { n++; candidate = `${rid}-${n}`; }
    logger.warn(`[${serviceName}] Duplicate researcher id '${rid}' → renumbered '${candidate}'`);
    r.id = candidate;
    seenIds.add(candidate);
  }

  // 2. Enforce global round budget
  let totalQueries = plan.researchers.reduce((sum, r) => sum + r.queries.length, 0);
  if (totalQueries > ROUND_HARD_CAP) {
    logger.warn(`[${serviceName}] Total round queries (${totalQueries}) exceeds hard cap (${ROUND_HARD_CAP}). Trimming...`);
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

  // If no researchers remain with valid queries, force synthesis
  if (plan.action === 'delegate' && plan.researchers.length === 0) {
    logger.warn(`[${serviceName}] No valid researchers after query cap/filtering, forcing synthesize`);
    return { ...plan, action: 'synthesize', researchers: [], allQueries: [] };
  }

  return plan;
}

/**
 * Generate researcher configurations from a plan
 */
export function generateResearchers(plan: ResearchPlan, _query: string, _complexity: 1 | 2 | 3): ResearcherConfig[] {
  if (!plan.researchers) {
    return [];
  }

  // Normalize IDs to strings
  const researchers = plan.researchers.map(r => ({
    ...r,
    id: String(r.id),
  }));

  return researchers;
}