/**
 * Research Swarm Reducer
 * 
 * PURE FUNCTION logic for state transitions. 
 * Contains 0 side effects. 100% testable without mocks.
 */

import type { SystemResearchState, SwarmEvent } from './swarm-types.ts';

export function swarmReducer(state: SystemResearchState, event: SwarmEvent): SystemResearchState {
  // Deep clone state to ensure true purity
  const newState: SystemResearchState = {
    ...state,
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
      if (event.finalSynthesis) {
        newState.finalSynthesis = event.finalSynthesis;
        newState.status = 'completed';
        newState.promotedId = undefined;
      } else if (event.nextQueries.length > 0 && newState.currentRound < event.maxRounds) {
        newState.currentRound++;
        newState.status = 'researching';
        newState.promotedId = undefined; // Reset for new round
        event.nextQueries.forEach((q: string, i: number) => {
          const id = `${newState.currentRound}.${i + 1}`;
          newState.aspects[id] = { id, query: q, status: 'pending' };
        });
      } else {
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
