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
export function getEvaluatorComplexityGuidance(complexity: 1 | 2 | 3): string {
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
export function getRoundPhaseGuidance(currentRound: number, maxRounds: number, complexity: 1 | 2 | 3): string {
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
 * Parse JSON from LLM response into ResearchPlan
 */
export function parseJsonPlan(text: string): ResearchPlan {
  const result = extractJson<unknown>(text, 'object');
  if (!result.success || !result.value) {
    const preview = text.length > 100 ? text.slice(0, 100) + '...' : text;
    throw new Error(`Failed to extract valid JSON plan: ${result.error}. Raw response preview: "${preview}"`);
  }

  // Robust validation using TypeBox
  try {
    // 1. Convert/Coerce values (e.g. string numbers to numbers, single values to arrays if possible)
    const coerced = Value.Convert(ResearchPlanSchema, result.value);
    
    // 2. Validate against schema
    if (!Value.Check(ResearchPlanSchema, coerced)) {
      const errors = [...Value.Errors(ResearchPlanSchema, coerced)];
      const errorMsg = errors.map((e: any) => `${e.path}: ${e.message}`).join(', ');
      // If validation fails, we throw to satisfy tests and ensure system integrity
      throw new Error(`Plan validation failed: ${errorMsg}`);
    }

    const plan = coerced as ResearchPlan;

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
  // Level 2: 3 researchers x 20 queries = 60 maximum
  // Level 3: 5 researchers x 30 queries = 150 maximum
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
        logger.warn(`[${serviceName}] Capping researcher ${normalized.id} queries: ${normalized.queries.length} → ${budget}`);
        normalized.queries = normalized.queries.slice(0, budget);
      }
      return normalized;
    });

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