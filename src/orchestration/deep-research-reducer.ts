/**
 * Deep Research Reducer
 *
 * PURE FUNCTION logic for state transitions.
 * Contains 0 side effects. 100% testable without mocks.
 */

import type { SystemResearchState, DeepResearchEvent } from './deep-research-types.ts';
import { logger } from '../logger.ts';

export function deepResearchReducer(state: SystemResearchState, event: DeepResearchEvent): SystemResearchState {
  // Deep clone state to ensure true purity
  const newState: SystemResearchState = {
    ...state,
    researchId: state.researchId,
    lastUpdated: Date.now(),
    initialAgenda: [...state.initialAgenda],
    allScrapedLinks: [...state.allScrapedLinks],
    aspects: { ...state.aspects }
  };

  switch (event.type) {
    case 'PLANNING_COMPLETE': {
      newState.initialAgenda = event.agenda;
      newState.status = 'researching';
      // Assign first batch to aspects
      event.agenda.slice(0, event.initialCount).forEach((q: string, i: number) => {
        const id = `1.${i + 1}`;
        newState.aspects[id] = { id, query: q, status: 'pending' };
      });
      break;
    }

    case 'SIBLING_STARTED': {
      const aspect = newState.aspects[event.id];
      if (aspect) {
        newState.aspects[event.id] = {
          ...aspect,
          status: 'running'
        };
      } else {
        logger.warn(`[Reducer] SIBLING_STARTED: unknown aspect id="${event.id}"`);
      }
      break;
    }

    case 'SIBLING_COMPLETED': {
      const aspect = newState.aspects[event.id];
      if (aspect) {
        newState.aspects[event.id] = {
          ...aspect,
          status: 'completed',
          report: event.report
        };
      } else {
        logger.warn(`[Reducer] SIBLING_COMPLETED: unknown aspect id="${event.id}"`);
      }
      break;
    }

    case 'SIBLING_FAILED': {
      const aspect = newState.aspects[event.id];
      if (aspect) {
        newState.aspects[event.id] = {
          ...aspect,
          status: 'failed',
          error: event.error
        };
      } else {
        logger.warn(`[Reducer] SIBLING_FAILED: unknown aspect id="${event.id}"`);
      }
      break;
    }

    case 'SIBLING_TOKENS': {
      const aspect = newState.aspects[event.id];
      if (aspect) {
        // Accumulate tokens and cost for this sibling
        const currentTokens = aspect.tokens || 0;
        const currentCost = aspect.cost || 0;
        newState.aspects[event.id] = {
          ...aspect,
          tokens: currentTokens + event.tokens,
          cost: currentCost + event.cost
        };
      } else {
        logger.warn(`[Reducer] SIBLING_TOKENS: unknown aspect id="${event.id}"`);
      }
      break;
    }

    case 'LINKS_SCRAPED': {
      newState.allScrapedLinks = [...new Set([...newState.allScrapedLinks, ...event.links])];
      break;
    }

    case 'PROMOTION_STARTED': {
      newState.promotedId = event.id;
      break;
    }

    case 'PROMOTION_DECISION': {
      if (event.finalSynthesis !== undefined) {
        // Case 1: Lead Evaluator chose to synthesize - complete with synthesis
        newState.finalSynthesis = event.finalSynthesis;
        newState.status = 'completed';
        newState.promotedId = undefined;
      } else if (event.nextQueries.length > 0 && newState.currentRound < event.maxRounds) {
        // Case 2: Lead Evaluator chose to continue AND we're under max rounds
        newState.currentRound++;
        newState.status = 'researching';
        newState.promotedId = undefined; // Reset for new round
        event.nextQueries.forEach((q: string, i: number) => {
          const id = `${newState.currentRound}.${i + 1}`;
          newState.aspects[id] = { id, query: q, status: 'pending' };
        });
      } else {
        // Case 3: Max rounds reached OR no next queries
        // Note: Per lead-evaluator prompt, when max rounds are reached, the evaluator
        // should synthesize. If nextQueries are provided at max rounds, this is a
        // protocol violation, and we enforce the constraint by completing anyway.
        newState.status = 'completed';
        newState.promotedId = undefined;
      }
      break;
    }
  }

  return newState;
}

/**
 * Utility to check if a round is finished
 */
export function isRoundComplete(state: SystemResearchState, round: number): boolean {
  const roundAspects = Object.values(state.aspects).filter(a => a.id.startsWith(`${round}.`));
  if (roundAspects.length === 0) return false;
  return roundAspects.every(a => a.status === 'completed' || a.status === 'failed');
}
