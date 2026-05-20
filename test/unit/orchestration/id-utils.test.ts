import { describe, it, expect } from 'vitest';
import { getDisplayNumber, getResearcherRoleContext } from '../../../src/orchestration/id-utils.ts';
import type { SystemResearchState } from '../../../src/orchestration/deep-research-types.ts';

function makeState(ids: string[]): SystemResearchState {
  return {
    version: 1,
    researchId: 'test',
    rootQuery: 'q',
    complexity: 1,
    currentRound: 1,
    status: 'researching',
    lastUpdated: 0,
    initialAgenda: [],
    allScrapedLinks: [],
    aspects: Object.fromEntries(
      ids.map(id => [id, { id, query: `query ${id}`, status: 'pending' as const }])
    ),
  };
}

describe('id-utils', () => {
  describe('getDisplayNumber', () => {
    it('maps single round IDs sequentially', () => {
      const state = makeState(['1.1', '1.2', '1.3']);
      expect(getDisplayNumber(state, '1.1')).toBe('1');
      expect(getDisplayNumber(state, '1.2')).toBe('2');
      expect(getDisplayNumber(state, '1.3')).toBe('3');
    });

    it('continues numbering across rounds', () => {
      const state = makeState(['1.1', '1.2', '2.1', '2.2']);
      expect(getDisplayNumber(state, '2.1')).toBe('3');
      expect(getDisplayNumber(state, '2.2')).toBe('4');
    });

    it('sorts correctly regardless of insertion order', () => {
      const state = makeState(['2.1', '1.2', '1.1']);
      expect(getDisplayNumber(state, '1.1')).toBe('1');
      expect(getDisplayNumber(state, '1.2')).toBe('2');
      expect(getDisplayNumber(state, '2.1')).toBe('3');
    });

    it('returns internalId for unknown ID', () => {
      const state = makeState(['1.1']);
      expect(getDisplayNumber(state, '9.9')).toBe('9.9');
    });

    it('handles empty aspects', () => {
      const state = makeState([]);
      expect(getDisplayNumber(state, '1.1')).toBe('1.1');
    });
  });

  describe('getResearcherRoleContext', () => {
    it('returns correct context for first researcher in round', () => {
      const state = makeState(['1.1', '1.2', '1.3']);
      const ctx = getResearcherRoleContext(state, '1.1');
      expect(ctx.roundNumber).toBe(1);
      expect(ctx.totalInRound).toBe(3);
      expect(ctx.isLastInRound).toBe(false);
      expect(ctx.displayNumber).toBe('1');
    });

    it('marks last researcher in round correctly', () => {
      const state = makeState(['1.1', '1.2', '1.3']);
      const ctx = getResearcherRoleContext(state, '1.3');
      expect(ctx.isLastInRound).toBe(true);
    });

    it('returns correct round number for round 2', () => {
      const state = makeState(['1.1', '2.1', '2.2']);
      const ctx = getResearcherRoleContext(state, '2.1');
      expect(ctx.roundNumber).toBe(2);
      expect(ctx.totalInRound).toBe(2);
    });

    it('handles single researcher in round', () => {
      const state = makeState(['1.1']);
      const ctx = getResearcherRoleContext(state, '1.1');
      expect(ctx.totalInRound).toBe(1);
      expect(ctx.isLastInRound).toBe(true);
    });
  });
});
