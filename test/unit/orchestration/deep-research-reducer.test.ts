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
});
