import { describe, it, expect, afterEach } from 'vitest';

import {
  createResearchObserver,
  createObserverState,
  type ObserverState,
} from '../../../src/observers/research-observer-impl.ts';
import {
  createInitialPanelState,
  clearAllFlashTimeouts,
  type ResearchPanelState,
} from '../../../src/tui/research-panel.ts';

/**
 * Regression guard for a bug that has regressed repeatedly: during the SEARCH
 * phase of rounds 2+, the panel collapsed to a single lone "eval" box animating
 * under the wave, instead of keeping the previous round's finished boxes visible
 * and clearing them all at once when the new round's researchers populate.
 *
 * The fix lives in research-observer-impl.ts:
 *   - onSearchStart no longer clears the previous round and no longer resurrects
 *     an 'eval' slice to host the "searching..." status.
 *   - The clear is deferred to onResearcherStart (atomic round transition).
 */
describe('multi-round TUI box lifecycle', () => {
  const researchIds: string[] = [];

  function makeObserver(): { panelState: ResearchPanelState; obs: ReturnType<typeof createResearchObserver>; state: ObserverState } {
    // Flash state is keyed by researchId, so give each observer a distinct one and
    // clear by that key — otherwise the afterEach cleanup silently misses the timers.
    const researchId = `rid-${researchIds.length}`;
    researchIds.push(researchId);
    const panelState = createInitialPanelState(`sess-${researchIds.length}`, researchId, 'q', 'model');
    const state = createObserverState();
    const obs = createResearchObserver(
      { panelState, debouncedRefresh: () => {}, researchComplexity: 2 },
      state,
    );
    return { panelState, obs, state };
  }

  afterEach(() => {
    for (const r of researchIds) clearAllFlashTimeouts(r);
    researchIds.length = 0;
  });

  function activeNonCompleted(panelState: ResearchPanelState): string[] {
    return [...panelState.slices.values()]
      .filter((s) => !s.completed && !s.queued)
      .map((s) => s.id);
  }

  it('keeps prior-round boxes through the next round search and never shows a lone eval search box', () => {
    const { panelState, obs } = makeObserver();

    // --- Round 1: plan -> search -> two researchers -> complete ---
    obs.onPlanningStart!(1);
    obs.onPlanningSuccess!({ action: 'delegate', researchers: [{}, {}], title: 'T' } as never);
    obs.onSearchStart!(['q']);
    // Round 1 search is hosted by the coordinator box (a real box, not 'eval').
    expect(panelState.slices.has('coord')).toBe(true);
    expect(panelState.slices.get('coord')!.completed).toBe(false);
    obs.onSearchComplete!(5);
    obs.onResearcherStart!('r1', 'A', 'g', 1);
    obs.onResearcherStart!('r2', 'B', 'g', 1);
    // Coordinator is removed once researchers begin.
    expect(panelState.slices.has('coord')).toBe(false);
    obs.onResearcherComplete!('r1', '' as never);
    obs.onResearcherComplete!('r2', '' as never);
    expect(panelState.slices.get('r1')!.completed).toBe(true);
    expect(panelState.slices.get('r2')!.completed).toBe(true);

    // --- Round 2 evaluation: eval box appears AMONG the grey round-1 boxes ---
    obs.onRoundStart!(2);
    obs.onEvaluationStart!(2);
    expect(panelState.slices.has('eval')).toBe(true);
    expect(panelState.slices.has('r1')).toBe(true);
    expect(panelState.slices.has('r2')).toBe(true);
    // exactly one active box (the evaluator) sitting among two grey researchers
    expect(activeNonCompleted(panelState)).toEqual(['eval']);

    obs.onEvaluationDecision!('delegate', { action: 'delegate', researchers: [{}] } as never, 2);
    expect(panelState.slices.get('eval')!.completed).toBe(true);

    // --- Round 2 search: THE REGRESSION GUARD ---
    obs.onSearchStart!(['q2']);
    expect(panelState.isSearching).toBe(true);
    // Previous round's boxes (and the now-grey eval) must still be present...
    expect(panelState.slices.has('r1')).toBe(true);
    expect(panelState.slices.has('r2')).toBe(true);
    expect(panelState.slices.has('eval')).toBe(true);
    // ...and there must be NO lone active box: the header wave is the sole indicator.
    expect(activeNonCompleted(panelState)).toEqual([]);

    obs.onSearchComplete!(3);
    expect(panelState.isSearching).toBe(false);

    // --- Round 2 researchers start: atomic clear, then new boxes populate ---
    obs.onResearcherStart!('r3', 'C', 'g', 2);
    expect(panelState.slices.has('r1')).toBe(false);
    expect(panelState.slices.has('r2')).toBe(false);
    expect(panelState.slices.has('eval')).toBe(false);
    expect(panelState.slices.get('r3')!.completed).toBe(false);
    expect(activeNonCompleted(panelState)).toEqual(['r3']);
  });
});
