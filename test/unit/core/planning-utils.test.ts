/**
 * Planning Utils Unit Tests
 *
 * Tests all exported functions from planning-utils.ts.
 * All functions under test are pure or near-pure — no mocks required.
 */

import { describe, it, expect } from 'vitest';
import {
  getTeamSize,
  getQueryBudget,
  getMaxRounds,
  getComplexityGuidance,
  getEvaluatorComplexityGuidance,
  getRoundPhaseGuidance,
  parseJsonPlan,
  buildFallbackCoordinatorPlan,
  capResearcherQueries,
  generateResearchers,
} from '../../../src/core/planning-utils.ts';

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
} from '../../../src/constants.ts';

// ---------------------------------------------------------------------------
// getTeamSize
// ---------------------------------------------------------------------------

describe('getTeamSize', () => {
  it('returns MAX_TEAM_SIZE_LEVEL_1 for complexity 1', () => {
    expect(getTeamSize(1)).toBe(MAX_TEAM_SIZE_LEVEL_1);
  });

  it('returns MAX_TEAM_SIZE_LEVEL_2 for complexity 2', () => {
    expect(getTeamSize(2)).toBe(MAX_TEAM_SIZE_LEVEL_2);
  });

  it('returns MAX_TEAM_SIZE_LEVEL_3 for complexity 3', () => {
    expect(getTeamSize(3)).toBe(MAX_TEAM_SIZE_LEVEL_3);
  });
});

// ---------------------------------------------------------------------------
// getQueryBudget
// ---------------------------------------------------------------------------

describe('getQueryBudget', () => {
  it('returns MAX_QUERIES_PER_RESEARCHER_LEVEL_1 for complexity 1', () => {
    expect(getQueryBudget(1)).toBe(MAX_QUERIES_PER_RESEARCHER_LEVEL_1);
  });

  it('returns MAX_QUERIES_PER_RESEARCHER_LEVEL_2 for complexity 2', () => {
    expect(getQueryBudget(2)).toBe(MAX_QUERIES_PER_RESEARCHER_LEVEL_2);
  });

  it('returns MAX_QUERIES_PER_RESEARCHER_LEVEL_3 for complexity 3', () => {
    expect(getQueryBudget(3)).toBe(MAX_QUERIES_PER_RESEARCHER_LEVEL_3);
  });
});

// ---------------------------------------------------------------------------
// getMaxRounds
// ---------------------------------------------------------------------------

describe('getMaxRounds', () => {
  it('returns MAX_ROUNDS_LEVEL_1 for complexity 1', () => {
    expect(getMaxRounds(1)).toBe(MAX_ROUNDS_LEVEL_1);
  });

  it('returns MAX_ROUNDS_LEVEL_2 for complexity 2', () => {
    expect(getMaxRounds(2)).toBe(MAX_ROUNDS_LEVEL_2);
  });

  it('returns MAX_ROUNDS_LEVEL_3 for complexity 3', () => {
    expect(getMaxRounds(3)).toBe(MAX_ROUNDS_LEVEL_3);
  });
});

// ---------------------------------------------------------------------------
// getComplexityGuidance
// ---------------------------------------------------------------------------

describe('getComplexityGuidance', () => {
  it('returns non-empty string for level 1', () => {
    const result = getComplexityGuidance(1, MAX_TEAM_SIZE_LEVEL_1, MAX_QUERIES_PER_RESEARCHER_LEVEL_1);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('returns non-empty string for level 2', () => {
    const result = getComplexityGuidance(2, MAX_TEAM_SIZE_LEVEL_2, MAX_QUERIES_PER_RESEARCHER_LEVEL_2);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('returns non-empty string for level 3', () => {
    const result = getComplexityGuidance(3, MAX_TEAM_SIZE_LEVEL_3, MAX_QUERIES_PER_RESEARCHER_LEVEL_3);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('level 3 guidance contains the maxTeamSize number', () => {
    const result = getComplexityGuidance(3, MAX_TEAM_SIZE_LEVEL_3, MAX_QUERIES_PER_RESEARCHER_LEVEL_3);
    expect(result).toContain(String(MAX_TEAM_SIZE_LEVEL_3));
  });

  it('level 3 guidance contains the queryBudget number', () => {
    const result = getComplexityGuidance(3, MAX_TEAM_SIZE_LEVEL_3, MAX_QUERIES_PER_RESEARCHER_LEVEL_3);
    expect(result).toContain(String(MAX_QUERIES_PER_RESEARCHER_LEVEL_3));
  });
});

// ---------------------------------------------------------------------------
// getEvaluatorComplexityGuidance
// ---------------------------------------------------------------------------

describe('getEvaluatorComplexityGuidance', () => {
  it('returns non-empty string for level 1', () => {
    const result = getEvaluatorComplexityGuidance(1);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('returns non-empty string for level 2', () => {
    const result = getEvaluatorComplexityGuidance(2);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('returns non-empty string for level 3', () => {
    const result = getEvaluatorComplexityGuidance(3);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('level 3 guidance mentions the MAX_ROUNDS_LEVEL_3 value', () => {
    const result = getEvaluatorComplexityGuidance(3);
    expect(result).toContain(String(MAX_ROUNDS_LEVEL_3));
  });
});

// ---------------------------------------------------------------------------
// getRoundPhaseGuidance
// ---------------------------------------------------------------------------

describe('getRoundPhaseGuidance', () => {
  // Early phase: roundRatio <= 0.5 → round 1 of 4 = 0.25
  it('early phase (level 1): round 1 of 4', () => {
    const result = getRoundPhaseGuidance(1, 4, 1);
    expect(result).toContain('EARLY');
    expect(result.length).toBeGreaterThan(0);
  });

  it('early phase (level 2): round 1 of 4', () => {
    const result = getRoundPhaseGuidance(1, 4, 2);
    expect(result).toContain('EARLY');
    expect(result.length).toBeGreaterThan(0);
  });

  it('early phase (level 3): round 1 of 4', () => {
    const result = getRoundPhaseGuidance(1, 4, 3);
    expect(result).toContain('EARLY');
    expect(result.length).toBeGreaterThan(0);
  });

  // Middle phase: 0.5 < roundRatio <= 0.8 → round 3 of 5 = 0.6
  it('middle phase (level 1): round 3 of 5', () => {
    const result = getRoundPhaseGuidance(3, 5, 1);
    expect(result).toContain('MIDDLE');
    expect(result.length).toBeGreaterThan(0);
  });

  it('middle phase (level 2): round 3 of 5', () => {
    const result = getRoundPhaseGuidance(3, 5, 2);
    expect(result).toContain('MIDDLE');
    expect(result.length).toBeGreaterThan(0);
  });

  it('middle phase (level 3): round 3 of 5', () => {
    const result = getRoundPhaseGuidance(3, 5, 3);
    expect(result).toContain('MIDDLE');
    expect(result.length).toBeGreaterThan(0);
  });

  // Late phase: roundRatio > 0.8 → round 4 of 5 = 0.8 is not > 0.8, use round 5 of 5 = 1.0
  it('late phase (level 1): round 5 of 5', () => {
    const result = getRoundPhaseGuidance(5, 5, 1);
    expect(result).toContain('LATE');
    expect(result.length).toBeGreaterThan(0);
  });

  it('late phase (level 2): round 5 of 5', () => {
    const result = getRoundPhaseGuidance(5, 5, 2);
    expect(result).toContain('LATE');
    expect(result.length).toBeGreaterThan(0);
  });

  it('late phase (level 3): round 5 of 5', () => {
    const result = getRoundPhaseGuidance(5, 5, 3);
    expect(result).toContain('LATE');
    expect(result.length).toBeGreaterThan(0);
  });

  // Boundary: roundRatio exactly 0.5 is still early
  it('roundRatio exactly 0.5 is early phase', () => {
    const result = getRoundPhaseGuidance(2, 4, 1);
    expect(result).toContain('EARLY');
  });

  // Boundary: roundRatio exactly 0.8 is still middle
  it('roundRatio exactly 0.8 is middle phase', () => {
    const result = getRoundPhaseGuidance(4, 5, 1);
    expect(result).toContain('MIDDLE');
  });
});

// ---------------------------------------------------------------------------
// parseJsonPlan
// ---------------------------------------------------------------------------

describe('parseJsonPlan', () => {
  const svc = 'test-service';

  it('parses valid JSON in a markdown code block', () => {
    const text = '```json\n{"action":"delegate","researchers":[{"id":"1","name":"R1","goal":"g","queries":["q1"]}],"allQueries":["q1"]}\n```';
    const plan = parseJsonPlan(text, svc);
    expect(plan.action).toBe('delegate');
    expect(Array.isArray(plan.researchers)).toBe(true);
    expect(plan.researchers![0]!.id).toBe('1');
  });

  it('parses valid raw JSON without a code block', () => {
    const text = '{"action":"synthesize","researchers":[{"id":"2","name":"R2","goal":"g2","queries":["q2","q3"]}],"allQueries":["q2","q3"]}';
    const plan = parseJsonPlan(text, svc);
    expect(plan.action).toBe('synthesize');
    expect(plan.researchers![0]!.queries).toEqual(['q2', 'q3']);
  });

  it('handles plan with multiple researchers having string IDs', () => {
    const text = JSON.stringify({
      action: 'delegate',
      researchers: [
        { id: 'a', name: 'RA', goal: 'ga', queries: ['qa1', 'qa2'] },
        { id: 'b', name: 'RB', goal: 'gb', queries: ['qb1'] },
      ],
      allQueries: ['qa1', 'qa2', 'qb1'],
    });
    const plan = parseJsonPlan(text, svc);
    expect(plan.researchers).toHaveLength(2);
    expect(plan.researchers![0]!.id).toBe('a');
    expect(plan.researchers![1]!.id).toBe('b');
  });

  it('normalizes numeric researcher IDs to strings', () => {
    const text = JSON.stringify({
      action: 'delegate',
      researchers: [
        { id: 42, name: 'R42', goal: 'g', queries: ['q1'] },
        { id: 7, name: 'R7', goal: 'g', queries: ['q2'] },
      ],
      allQueries: ['q1', 'q2'],
    });
    const plan = parseJsonPlan(text, svc);
    expect(plan.researchers![0]!.id).toBe('42');
    expect(plan.researchers![1]!.id).toBe('7');
  });

  it('throws when researchers array is missing', () => {
    const text = JSON.stringify({ action: 'delegate', allQueries: [] });
    expect(() => parseJsonPlan(text, svc)).toThrow(/researchers/i);
  });

  it('throws when a researcher has no queries array', () => {
    const text = JSON.stringify({
      action: 'delegate',
      researchers: [{ id: '1', name: 'R1', goal: 'g' }],
      allQueries: [],
    });
    expect(() => parseJsonPlan(text, svc)).toThrow(/queries/i);
  });

  it('throws on completely malformed text', () => {
    expect(() => parseJsonPlan('this is not json at all', svc)).toThrow();
  });

  it('throws on empty string', () => {
    expect(() => parseJsonPlan('', svc)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// buildFallbackCoordinatorPlan
// ---------------------------------------------------------------------------

describe('buildFallbackCoordinatorPlan', () => {
  const svc = 'test-service';

  it('returns a plan with action delegate', () => {
    const plan = buildFallbackCoordinatorPlan(svc, '', 'test query');
    expect(plan.action).toBe('delegate');
  });

  it('returns exactly one researcher', () => {
    const plan = buildFallbackCoordinatorPlan(svc, '', 'test query');
    expect(plan.researchers).toHaveLength(1);
  });

  it('queries are derived from the query string', () => {
    const query = 'what is the capital of France';
    const plan = buildFallbackCoordinatorPlan(svc, '', query);
    // The first query should be the full query
    expect(plan.researchers![0]!.queries[0]).toBe(query);
    // allQueries should match the researcher queries
    expect(plan.allQueries).toEqual(plan.researchers![0]!.queries);
  });

  it('allQueries matches the single researcher queries', () => {
    const plan = buildFallbackCoordinatorPlan(svc, 'raw text', 'some topic');
    expect(plan.allQueries).toEqual(plan.researchers![0]!.queries);
  });
});

// ---------------------------------------------------------------------------
// capResearcherQueries
// ---------------------------------------------------------------------------

describe('capResearcherQueries', () => {
  const svc = 'test-service';

  function makeResearcher(id: string, queryCount: number) {
    return {
      id,
      name: `Researcher ${id}`,
      goal: 'research goal',
      queries: Array.from({ length: queryCount }, (_, i) => `query-${id}-${i}`),
    };
  }

  it('does not trim a researcher whose queries are under budget (level 1)', () => {
    const r = makeResearcher('1', MAX_QUERIES_PER_RESEARCHER_LEVEL_1 - 1);
    const plan = { action: 'delegate' as const, researchers: [r], allQueries: [] };
    const result = capResearcherQueries(plan, 1, svc);
    expect(result.researchers![0]!.queries).toHaveLength(MAX_QUERIES_PER_RESEARCHER_LEVEL_1 - 1);
  });

  it('trims a researcher to budget for level 1 when over budget', () => {
    const r = makeResearcher('1', MAX_QUERIES_PER_RESEARCHER_LEVEL_1 + 5);
    const plan = { action: 'delegate' as const, researchers: [r], allQueries: [] };
    const result = capResearcherQueries(plan, 1, svc);
    expect(result.researchers![0]!.queries).toHaveLength(MAX_QUERIES_PER_RESEARCHER_LEVEL_1);
  });

  it('trims a researcher to budget for level 2 when over budget', () => {
    const r = makeResearcher('1', MAX_QUERIES_PER_RESEARCHER_LEVEL_2 + 10);
    const plan = { action: 'delegate' as const, researchers: [r], allQueries: [] };
    const result = capResearcherQueries(plan, 2, svc);
    expect(result.researchers![0]!.queries).toHaveLength(MAX_QUERIES_PER_RESEARCHER_LEVEL_2);
  });

  it('trims a researcher to budget for level 3 when over budget', () => {
    const r = makeResearcher('1', MAX_QUERIES_PER_RESEARCHER_LEVEL_3 + 10);
    const plan = { action: 'delegate' as const, researchers: [r], allQueries: [] };
    const result = capResearcherQueries(plan, 3, svc);
    expect(result.researchers![0]!.queries).toHaveLength(MAX_QUERIES_PER_RESEARCHER_LEVEL_3);
  });

  it('enforces hard cap of 20 for level 1 across multiple researchers', () => {
    // Level 1 cap = 20, two researchers each at budget (10) = 20, should be fine at boundary
    // Push over: two researchers with 15 each
    const researchers = [
      makeResearcher('1', 15),
      makeResearcher('2', 15),
    ];
    const plan = { action: 'delegate' as const, researchers, allQueries: [] };
    const result = capResearcherQueries(plan, 1, svc);
    const total = result.researchers!.reduce((sum, r) => sum + r.queries.length, 0);
    expect(total).toBeLessThanOrEqual(20);
  });

  it('enforces hard cap of 60 for level 2 across multiple researchers', () => {
    // Three researchers with 25 each = 75 total, over the 60 cap
    const researchers = [
      makeResearcher('1', 25),
      makeResearcher('2', 25),
      makeResearcher('3', 25),
    ];
    const plan = { action: 'delegate' as const, researchers, allQueries: [] };
    const result = capResearcherQueries(plan, 2, svc);
    const total = result.researchers!.reduce((sum, r) => sum + r.queries.length, 0);
    expect(total).toBeLessThanOrEqual(60);
  });

  it('enforces hard cap of 150 for level 3 across multiple researchers', () => {
    // Five researchers with 40 each = 200 total, but per-researcher cap of 30 brings it to 150 first
    // Use 5 researchers with 31 each: per-researcher cap → 30 each = 150 total, at the cap boundary
    // Use 5 researchers with 35 each: after per-cap → 30 each = 150, at boundary
    // To force global trimming use fewer researchers with no per-researcher violation
    // Level 3 per-researcher budget = 30; hard cap = 150 = 5*30, so per-researcher cap alone may handle it
    // Construct a case with under-budget but total over cap: not possible since 5*30=150
    // Instead use researcher count over team limit but that is not validated here
    // A simpler path: manually set queries at 29 each for 6 researchers (174 total)
    const researchers = Array.from({ length: 6 }, (_, i) => makeResearcher(String(i + 1), 29));
    const plan = { action: 'delegate' as const, researchers, allQueries: [] };
    const result = capResearcherQueries(plan, 3, svc);
    const total = result.researchers!.reduce((sum, r) => sum + r.queries.length, 0);
    expect(total).toBeLessThanOrEqual(150);
  });

  it('filters out a researcher with an empty queries array', () => {
    const researchers = [
      makeResearcher('1', 3),
      { id: '2', name: 'R2', goal: 'g', queries: [] },
    ];
    const plan = { action: 'delegate' as const, researchers, allQueries: [] };
    const result = capResearcherQueries(plan, 1, svc);
    expect(result.researchers!.every(r => r.queries.length > 0)).toBe(true);
    expect(result.researchers!.find(r => r.id === '2')).toBeUndefined();
  });

  it('filters out a researcher with no queries property (undefined)', () => {
    const researchers = [
      makeResearcher('1', 3),
      { id: '3', name: 'R3', goal: 'g' } as any,
    ];
    const plan = { action: 'delegate' as const, researchers, allQueries: [] };
    const result = capResearcherQueries(plan, 1, svc);
    expect(result.researchers!.find(r => r.id === '3')).toBeUndefined();
  });

  it('sets allQueries to the correct flat array of remaining queries', () => {
    const researchers = [
      makeResearcher('1', 2),
      makeResearcher('2', 3),
    ];
    const plan = { action: 'delegate' as const, researchers, allQueries: [] };
    const result = capResearcherQueries(plan, 2, svc);
    const expected = result.researchers!.flatMap(r => r.queries);
    expect(result.allQueries).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// generateResearchers
// ---------------------------------------------------------------------------

describe('generateResearchers', () => {
  it('returns empty array when plan has no researchers', () => {
    const plan = { action: 'delegate' as const, researchers: [], allQueries: [] };
    expect(generateResearchers(plan, 'q', 1)).toEqual([]);
  });

  it('returns empty array when researchers is undefined', () => {
    const plan = { action: 'synthesize' as const, allQueries: [] } as any;
    expect(generateResearchers(plan, 'q', 1)).toEqual([]);
  });

  it('normalizes numeric IDs to strings', () => {
    const plan = {
      action: 'delegate' as const,
      researchers: [
        { id: 10 as any, name: 'R10', goal: 'g', queries: ['q1'] },
      ],
      allQueries: ['q1'],
    };
    const result = generateResearchers(plan, 'q', 1);
    expect(result[0]!.id).toBe('10');
  });

  it('preserves string IDs unchanged', () => {
    const plan = {
      action: 'delegate' as const,
      researchers: [
        { id: 'abc', name: 'Rabc', goal: 'g', queries: ['q1'] },
      ],
      allQueries: ['q1'],
    };
    const result = generateResearchers(plan, 'q', 2);
    expect(result[0]!.id).toBe('abc');
  });

  it('preserves all researcher fields', () => {
    const researcher = {
      id: '1',
      name: 'R1',
      goal: 'do research',
      queries: ['a', 'b'],
      historicalLinks: ['http://example.com'],
    };
    const plan = {
      action: 'delegate' as const,
      researchers: [researcher],
      allQueries: ['a', 'b'],
    };
    const result = generateResearchers(plan, 'q', 3);
    expect(result[0]).toMatchObject({
      id: '1',
      name: 'R1',
      goal: 'do research',
      queries: ['a', 'b'],
      historicalLinks: ['http://example.com'],
    });
  });

  it('returns one entry per researcher in plan', () => {
    const plan = {
      action: 'delegate' as const,
      researchers: [
        { id: '1', name: 'R1', goal: 'g1', queries: ['q1'] },
        { id: '2', name: 'R2', goal: 'g2', queries: ['q2'] },
        { id: '3', name: 'R3', goal: 'g3', queries: ['q3'] },
      ],
      allQueries: ['q1', 'q2', 'q3'],
    };
    const result = generateResearchers(plan, 'q', 2);
    expect(result).toHaveLength(3);
  });
});
