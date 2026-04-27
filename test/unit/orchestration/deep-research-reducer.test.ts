/**
 * Deep Research Reducer Unit Tests
 *
 * Tests the core orchestration logic with ZERO mocks.
 */

import { describe, it, expect } from 'vitest';
import { deepResearchReducer, isRoundComplete } from '../../../src/orchestration/deep-research-reducer';
import type { SystemResearchState } from '../../../src/orchestration/deep-research-types';

describe('deepResearchReducer', () => {
  const initialState: SystemResearchState = {
    version: 1,
    researchId: 'test-research-id',
    rootQuery: 'test query',
    complexity: 2,
    currentRound: 1,
    status: 'planning',
    lastUpdated: 0,
    initialAgenda: [],
    allScrapedLinks: [],
    aspects: {},
  };

  it('should handle PLANNING_COMPLETE', () => {
    const agenda = ['aspect 1', 'aspect 2', 'aspect 3', 'aspect 4'];
    const nextState = deepResearchReducer(initialState, {
      type: 'PLANNING_COMPLETE',
      agenda,
      initialCount: 3
    });

    expect(nextState.status).toBe('researching');
    expect(nextState.initialAgenda).toEqual(agenda);
    expect(Object.keys(nextState.aspects)).toHaveLength(3);
    expect(nextState.aspects['1.1']?.query).toBe('aspect 1');
  });

  it('should track sibling completion', () => {
    let state = { ...initialState, aspects: { '1.1': { id: '1.1', query: 'q', status: 'pending' } } } as any;
    state = deepResearchReducer(state, { type: 'SIBLING_COMPLETED', id: '1.1', report: 'findings' });

    expect(state.aspects['1.1'].status).toBe('completed');
    expect(state.aspects['1.1'].report).toBe('findings');
  });

  it('should track sibling failure', () => {
    let state = { ...initialState, aspects: { '1.1': { id: '1.1', query: 'q', status: 'pending' } } } as any;
    state = deepResearchReducer(state, { type: 'SIBLING_FAILED', id: '1.1', error: 'some error' });

    expect(state.aspects['1.1'].status).toBe('failed');
    expect(state.aspects['1.1'].error).toBe('some error');
  });

  it('should correctly identify when a round is complete', () => {
    const state: any = {
      aspects: {
        '1.1': { id: '1.1', status: 'completed' },
        '1.2': { id: '1.2', status: 'failed' },
        '2.1': { id: '2.1', status: 'pending' }
      }
    };

    expect(isRoundComplete(state, 1)).toBe(true);
    expect(isRoundComplete(state, 2)).toBe(false);
  });

  it('should handle PROMOTION_DECISION to next round', () => {
    const state = { ...initialState, currentRound: 1 as const, status: 'researching' as const };
    const nextState = deepResearchReducer(state, {
      type: 'PROMOTION_DECISION',
      nextQueries: ['new q1'],
      maxRounds: 3
    });

    expect(nextState.currentRound).toBe(2);
    expect(nextState.status).toBe('researching');
    expect(nextState.aspects['2.1']?.query).toBe('new q1');
  });

  it('should handle final synthesis in PROMOTION_DECISION', () => {
    const state = { ...initialState, status: 'researching' as const };
    const nextState = deepResearchReducer(state, {
      type: 'PROMOTION_DECISION',
      nextQueries: [],
      finalSynthesis: 'the end',
      maxRounds: 3
    });

    expect(nextState.status).toBe('completed');
    expect(nextState.finalSynthesis).toBe('the end');
  });

  it('should complete when max rounds reached even if next queries provided', () => {
    const state = { ...initialState, currentRound: 3 as const, status: 'researching' as const };
    const nextState = deepResearchReducer(state, {
      type: 'PROMOTION_DECISION',
      nextQueries: ['ignored query'],
      maxRounds: 3,
    });
    expect(nextState.status).toBe('completed');
    expect(nextState.currentRound).toBe(3);
  });

  it('should handle SIBLING_STARTED', () => {
    const state: any = {
      ...initialState,
      aspects: { '1.1': { id: '1.1', query: 'q', status: 'pending' } },
    };
    const next = deepResearchReducer(state, { type: 'SIBLING_STARTED', id: '1.1' });
    expect(next.aspects['1.1']?.status).toBe('running');
  });

  it('should handle SIBLING_TOKENS accumulation', () => {
    const state: any = {
      ...initialState,
      aspects: { '1.1': { id: '1.1', query: 'q', status: 'running', tokens: 100, cost: 0.001 } },
    };
    const next = deepResearchReducer(state, {
      type: 'SIBLING_TOKENS',
      id: '1.1',
      tokens: 500,
      cost: 0.005,
    });
    expect(next.aspects['1.1']?.tokens).toBe(600);
    expect(next.aspects['1.1']?.cost).toBeCloseTo(0.006);
  });

  it('should deduplicate links in LINKS_SCRAPED', () => {
    const state: any = { ...initialState, allScrapedLinks: ['https://a.com'] };
    const next = deepResearchReducer(state, {
      type: 'LINKS_SCRAPED',
      links: ['https://a.com', 'https://b.com'],
    });
    expect(next.allScrapedLinks).toEqual(['https://a.com', 'https://b.com']);
  });

  it('should set promotedId on PROMOTION_STARTED', () => {
    const state: any = { ...initialState };
    const next = deepResearchReducer(state, { type: 'PROMOTION_STARTED', id: '1.1' });
    expect(next.promotedId).toBe('1.1');
  });

  it('should not mutate original state', () => {
    const state: any = {
      ...initialState,
      aspects: { '1.1': { id: '1.1', query: 'q', status: 'pending' } },
    };
    deepResearchReducer(state, { type: 'SIBLING_STARTED', id: '1.1' });
    expect(state.aspects['1.1'].status).toBe('pending');
  });

  it('should silently ignore events for unknown aspect IDs', () => {
    const state: any = {
      ...initialState,
      aspects: { '1.1': { id: '1.1', query: 'q', status: 'pending' } },
    };
    const nextStarted   = deepResearchReducer(state, { type: 'SIBLING_STARTED',   id: '9.9' });
    const nextCompleted = deepResearchReducer(state, { type: 'SIBLING_COMPLETED', id: '9.9', report: 'x' });
    const nextFailed    = deepResearchReducer(state, { type: 'SIBLING_FAILED',    id: '9.9', error: 'e' });
    const nextTokens    = deepResearchReducer(state, { type: 'SIBLING_TOKENS',    id: '9.9', tokens: 1, cost: 0 });

    for (const next of [nextStarted, nextCompleted, nextFailed, nextTokens]) {
      expect(next.aspects['1.1']?.status).toBe('pending');
      expect(next.aspects['9.9']).toBeUndefined();
    }
  });
});
