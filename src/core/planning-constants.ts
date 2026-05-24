/**
 * Planning Constants
 *
 * Configuration values for the planning service.
 */

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
 * Team size by complexity level
 */
export const TEAM_SIZE_BY_COMPLEXITY = {
  1: MAX_TEAM_SIZE_LEVEL_1,
  2: MAX_TEAM_SIZE_LEVEL_2,
  3: MAX_TEAM_SIZE_LEVEL_3,
} as const;

/**
 * Max rounds by complexity level
 */
export const MAX_ROUNDS_BY_COMPLEXITY = {
  1: MAX_ROUNDS_LEVEL_1,
  2: MAX_ROUNDS_LEVEL_2,
  3: MAX_ROUNDS_LEVEL_3,
} as const;

/**
 * Query budget per researcher by complexity level
 */
export const QUERY_BUDGET_BY_COMPLEXITY = {
  1: MAX_QUERIES_PER_RESEARCHER_LEVEL_1,
  2: MAX_QUERIES_PER_RESEARCHER_LEVEL_2,
  3: MAX_QUERIES_PER_RESEARCHER_LEVEL_3,
} as const;

/**
 * Get team size for complexity level
 */
export function getTeamSize(complexity: 1 | 2 | 3): number {
  return TEAM_SIZE_BY_COMPLEXITY[complexity];
}

/**
 * Get max rounds for complexity level
 */
export function getMaxRounds(complexity: 1 | 2 | 3): number {
  return MAX_ROUNDS_BY_COMPLEXITY[complexity];
}

/**
 * Get query budget for complexity level
 */
export function getQueryBudget(complexity: 1 | 2 | 3): number {
  return QUERY_BUDGET_BY_COMPLEXITY[complexity];
}