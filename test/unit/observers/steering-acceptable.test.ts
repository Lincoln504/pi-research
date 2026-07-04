/**
 * steeringAcceptable lifecycle + quick-label truncation in the TUI observer.
 *
 * Regression guards:
 *  - onSynthesisStart must flip steeringAcceptable OFF even though
 *    onEvaluationStart (re-fired on the forced/maxRounds synthesis path) had just
 *    re-enabled it. Otherwise a steer typed during forced final synthesis was
 *    queued with an affirmative "will steer the next research round" toast and
 *    then destroyed at teardown — there is no next round.
 *  - onStart must truncate the quick-mode query at a codepoint boundary:
 *    query.slice(0, 20) could split a surrogate pair and put a lone surrogate
 *    into the slice label (rendered as � and corrupting width math).
 */
import { describe, it, expect, afterEach } from 'vitest';

import {
  createResearchObserver,
  createObserverState,
} from '../../../src/observers/research-observer-impl.ts';
import {
  createInitialPanelState,
  clearAllFlashTimeouts,
  type ResearchPanelState,
} from '../../../src/tui/research-panel.ts';

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('steeringAcceptable lifecycle', () => {
  const researchIds: string[] = [];

  function makeObserver(complexity = 2) {
    const researchId = `steer-rid-${researchIds.length}`;
    researchIds.push(researchId);
    const panelState: ResearchPanelState = createInitialPanelState(`steer-sess-${researchIds.length}`, researchId, 'q', 'model');
    const state = createObserverState();
    const obs = createResearchObserver(
      { panelState, debouncedRefresh: () => {}, researchComplexity: complexity },
      state,
    );
    return { panelState, obs, state };
  }

  afterEach(() => {
    for (const r of researchIds) clearAllFlashTimeouts(r);
    researchIds.length = 0;
  });

  it('onSynthesisStart flips steering off even right after onEvaluationStart re-enabled it (forced-synthesis path)', () => {
    const { panelState, obs } = makeObserver();

    // Simulate the deep forced-synthesis sequence at the round cap:
    obs.onEvaluationStart!(3);
    expect(panelState.steeringAcceptable).toBe(true); // in-loop evals legitimately keep it on
    obs.onEvaluationProgress!('evaluating');

    obs.onSynthesisStart!();
    expect(panelState.steeringAcceptable).toBe(false);
  });

  it('onSynthesisStart is idempotent after the evaluator-chose-synthesize decision already flipped it', () => {
    const { panelState, obs } = makeObserver();
    obs.onEvaluationStart!(2);
    obs.onEvaluationDecision!('synthesize', undefined, 2);
    expect(panelState.steeringAcceptable).toBe(false);
    obs.onSynthesisStart!();
    expect(panelState.steeringAcceptable).toBe(false);
  });

  it('delegation decisions still re-enable steering (unchanged behavior)', () => {
    const { panelState, obs } = makeObserver();
    obs.onEvaluationStart!(2);
    obs.onEvaluationDecision!('delegate', { action: 'delegate', researchers: [] } as never, 2);
    expect(panelState.steeringAcceptable).toBe(true);
  });
});

describe('quick-mode label truncation', () => {
  const researchIds: string[] = [];

  afterEach(() => {
    for (const r of researchIds) clearAllFlashTimeouts(r);
    researchIds.length = 0;
  });

  function startQuick(query: string) {
    const researchId = `trunc-rid-${researchIds.length}`;
    researchIds.push(researchId);
    const panelState = createInitialPanelState('trunc-sess', researchId, query, 'model');
    const state = createObserverState();
    const obs = createResearchObserver(
      { panelState, debouncedRefresh: () => {}, researchComplexity: 0 },
      state,
    );
    obs.onStart!(query, 0);
    return { panelState, state };
  }

  it('never splits a surrogate pair (emoji query longer than the 20-codepoint cap)', () => {
    // 'a' + 30 rockets: slicing 20 CODE UNITS lands mid-pair (odd offset into pairs).
    const query = 'a' + '🚀'.repeat(30);
    const { state } = startQuick(query);
    expect(LONE_SURROGATE.test(state.quickSliceLabel)).toBe(false);
    expect(state.quickSliceLabel.endsWith('...')).toBe(true);
    // 20 codepoints kept: 'a' + 19 rockets.
    expect(state.quickSliceLabel).toBe(`researching: a${'🚀'.repeat(19)}...`);
  });

  it('leaves short queries untouched (codepoint count, not code units, drives the cap)', () => {
    // 15 emoji = 30 code units but only 15 codepoints — must NOT be truncated.
    const query = '🚀'.repeat(15);
    const { state } = startQuick(query);
    expect(state.quickSliceLabel).toBe(`researching: ${query}`);
  });

  it('still truncates long ASCII queries as before', () => {
    const query = 'x'.repeat(25);
    const { state } = startQuick(query);
    expect(state.quickSliceLabel).toBe(`researching: ${'x'.repeat(20)}...`);
  });
});
