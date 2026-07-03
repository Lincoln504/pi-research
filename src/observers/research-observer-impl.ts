/**
 * Research Observer Implementation
 *
 * Implements the ResearchObserver interface to handle research lifecycle events:
 * - Research planning
 * - Searching and scraping
 * - Researcher lifecycle
 * - Evaluation
 * - Completion and errors
 */

import type { ResearchObserver } from '../core/interfaces/observer-interfaces.ts';

import { getUnitsPerResearcher, LEAD_EVAL_UNITS } from '../constants.ts';
import type { ResearchPanelState } from '../tui/research-panel.ts';
import { tuiPulse } from '../tui/pulse.ts';
import {
  addSlice,
  activateSlice,
  completeSlice,
  removeSlice,
  flashSlice,
  updateSliceTokens,
  updateSliceStatus,
  reactivateSlice,
  clearCompletedResearchers,
} from '../tui/research-panel.ts';

export interface ObserverContext {
  panelState: ResearchPanelState;
  debouncedRefresh: () => void;
  /**
   * Immediate (non-debounced) render for animation frames. Optional so
   * headless/test contexts can omit it; falls back to debouncedRefresh.
   */
  renderImmediate?: () => void;
  researchComplexity: number;
}

export interface ObserverState {
  progressCredits: Map<string, number>;
  quickSliceLabel: string;
  idToNumberMap: Map<string, string>;
  unsubPulse: (() => void) | null;
  /** Global pulse frame captured when the current search began, so each
   *  search's wave starts at the left edge (frame 0) regardless of the
   *  never-reset global pulse counter. */
  waveBaseFrame: number;
}

/**
 * Create a ResearchObserver implementation
 */
export function createResearchObserver(
  ctx: ObserverContext,
  state: ObserverState
): ResearchObserver {
  const {
    panelState,
    debouncedRefresh,
  } = ctx;

  // Drive animation frames through the immediate render path so they are not
  // swallowed by the state-refresh debounce. Falls back to debouncedRefresh
  // when no immediate path is wired (headless/tests).
  const renderFrame = ctx.renderImmediate ?? debouncedRefresh;
  
  const {
    progressCredits,
  } = state;

  return {
    onStart: (query, complexity) => {
      if (complexity === 0) {
        const truncatedQuery = query.length > 20 ? query.slice(0, 20) + '...' : query;
        state.quickSliceLabel = `researching: ${truncatedQuery}`;
        addSlice(panelState, state.quickSliceLabel, state.quickSliceLabel, false);
        activateSlice(panelState, state.quickSliceLabel);
        updateSliceStatus(panelState, state.quickSliceLabel, 'starting...', debouncedRefresh);

        const units = getUnitsPerResearcher();
        panelState.progress = { expected: units, made: 0 };
      }
      // Quick research: researcher is running → steering is acceptable
      panelState.steeringAcceptable = true;
      debouncedRefresh();
    },

    onPlanningStart: (attempt) => {
      if (attempt === 1) {
        addSlice(panelState, 'coord', `coordinator`, false);
        activateSlice(panelState, 'coord');
      }
      const status = attempt > 1 ? `planning (retry ${attempt - 1})` : 'planning';
      updateSliceStatus(panelState, 'coord', status, debouncedRefresh);
      // Keep steering acceptable: the coordinator LLM cannot be interrupted, but a
      // message entered now is queued (not injected mid-call) and consumed at the
      // next round boundary. Forcing it false here diverted it to a separate pi
      // follow-up turn that never reached this run's evaluator.
      panelState.steeringAcceptable = true;
      debouncedRefresh();
    },

    onPlanningProgress: (status) => {
      updateSliceStatus(panelState, 'coord', status, debouncedRefresh);
      debouncedRefresh();
    },

    onPlanningTokens: (tokens, cost) => {
      // Per-slice display only. Run totals are owned by the metrics registry
      // (see research-tool-definition.ts → extractRunStats), not panelState.
      updateSliceTokens(panelState, 'coord', tokens, cost);
      debouncedRefresh();
    },

    onPlanningSuccess: (plan) => {
      updateSliceStatus(panelState, 'coord', 'ready', debouncedRefresh);
      completeSlice(panelState, 'coord');
      const unitsPerResearcher = getUnitsPerResearcher();
      const count = plan.researchers?.length || 0;
      const units = (count * unitsPerResearcher) + LEAD_EVAL_UNITS;
      panelState.progress = { expected: units, made: 0 };
      panelState.title = plan.title?.trim() || 'Research';
      // Coordinator done — about to start search then researchers → steering acceptable
      panelState.steeringAcceptable = true;
      debouncedRefresh();
    },

    onRoundStart: (round) => {
      // Mark that we need to clear completed slices once the next round's evaluation or search starts.
      // This keeps previous round findings visible during the evaluation phase.
      if (round > 1) {
        panelState.needsClear = true;
      }
    },

    onSearchStart: (_queries) => {
      // Do NOT clear the previous round's finished boxes here. They stay visible
      // (greyed) throughout this round's search so the panel never collapses to a
      // single lone box mid-wave. The deferred clear runs atomically in
      // onResearcherStart, so every old box (researchers + evaluator) disappears
      // at once and the new round populates in their place. (needsClear is set by
      // onRoundStart and consumed there.)

      // Bind the "searching..." status to a real, phase-appropriate box only:
      //   - quick mode: the single quick-researcher slice
      //   - round 1:    the coordinator slice (still present before researchers)
      //   - rounds 2+:  NONE. The coordinator is gone and the evaluator must NOT
      //     be resurrected as a lone search box (that is the regression this
      //     guards against). The animated header wave is the search indicator.
      let sliceId: string | null = null;
      if (state.quickSliceLabel) {
        sliceId = state.quickSliceLabel;
      } else if (panelState.slices.has('coord')) {
        sliceId = 'coord';
      }

      if (sliceId && panelState.slices.has(sliceId)) {
        reactivateSlice(panelState, sliceId);
        activateSlice(panelState, sliceId); // Ensure not queued
        updateSliceStatus(panelState, sliceId, 'searching...', debouncedRefresh);
      }
      panelState.isSearching = true;

      // Search phase — steering is acceptable (will be consumed at next round boundary)
      panelState.steeringAcceptable = true;

      // Start wave animation via global pulse subscription.
      // Capture the current global frame as the baseline so this search's wave
      // starts at frame 0 (left edge). Position is frame % PERIOD_FRAMES, and
      // the global counter is never reset, so without this each search would
      // begin at an arbitrary point in the cycle.
      state.waveBaseFrame = tuiPulse.getFrame();
      panelState.waveFrame = 0;

      if (state.unsubPulse) state.unsubPulse();
      state.unsubPulse = tuiPulse.subscribe((globalFrame) => {
        if (!panelState.isSearching) {
          if (state.unsubPulse) {
            state.unsubPulse();
            state.unsubPulse = null;
          }
          return;
        }
        panelState.waveFrame = globalFrame - state.waveBaseFrame;
        // Animation frame: render immediately. pi-tui's render scheduler
        // (16ms throttle + line-level diff) coalesces and caps these, so the
        // wave updates every frame without the 100ms state-refresh debounce
        // dropping frames.
        renderFrame();
      });

      debouncedRefresh();
    },

    onSearchProgress: (count) => {
      // Only the coordinator (round 1) or quick slice carries a textual search
      // count. Rounds 2+ have no search box (header wave only) — see onSearchStart.
      let sliceId: string | null = null;
      if (state.quickSliceLabel) sliceId = state.quickSliceLabel;
      else if (panelState.slices.has('coord')) sliceId = 'coord';

      const status = `${count} results`;
      if (sliceId) updateSliceStatus(panelState, sliceId, status, debouncedRefresh);
      debouncedRefresh();
    },

    onSearchComplete: (count) => {
      panelState.isSearching = false;

      // Stop wave animation
      if (state.unsubPulse) {
        state.unsubPulse();
        state.unsubPulse = null;
      }
      panelState.waveFrame = undefined;
      panelState.waveColors = undefined; // Clear persistent colors for next search

      // Mirror onSearchStart: only complete a box that actually hosted the search
      // (coordinator in round 1, quick slice in quick mode). Rounds 2+ have none.
      let sliceId: string | null = null;
      if (state.quickSliceLabel) sliceId = state.quickSliceLabel;
      else if (panelState.slices.has('coord')) sliceId = 'coord';

      if (sliceId) {
        updateSliceStatus(panelState, sliceId, `${count} results`, debouncedRefresh);
        // In quick mode the single researcher keeps working (scraping) after search
        // completes — completing its slice here would mute it and swallow the per-URL
        // scrape flashes/status pops the wiring exists to show. Only the coordinator's
        // round-1 search box is genuinely done at this point; the quick slice is
        // completed later by onResearcherComplete/onResearcherFailure.
        if (sliceId === 'coord') completeSlice(panelState, sliceId);
      }
      debouncedRefresh();
    },

    onResearcherStart: (id, _name, _goal, _roundNumber) => {
      if (panelState.slices.get('coord')?.completed) removeSlice(panelState, 'coord');

      // Atomic round transition: this is the single point where the previous
      // round's finished boxes (researchers AND evaluator) are cleared, right as
      // the new round's first researcher appears — so they all vanish together and
      // the new round populates in their place, never leaving a lone box on screen.
      // clearCompletedResearchers already removes the completed 'eval'; the explicit
      // removeSlice is a defensive backstop for the rare path where needsClear is
      // unset (e.g. round 1 has no prior eval, so it is simply a no-op there).
      if (panelState.slices.get('eval')?.completed) removeSlice(panelState, 'eval');
      if (panelState.needsClear) {
        clearCompletedResearchers(panelState);
        panelState.needsClear = false;
      }

      // Map internal hierarchical ID to sequential display number for TUI
      const sliceId = id === 'quick' ? state.quickSliceLabel : id;
      
      if (!panelState.slices.has(sliceId)) {
        let label: string;
        if (id === 'quick') {
          label = state.quickSliceLabel;
        } else {
          if (!state.idToNumberMap.has(id)) {
            state.idToNumberMap.set(id, (state.idToNumberMap.size + 1).toString());
          }
          label = state.idToNumberMap.get(id)!;
        }
        addSlice(panelState, sliceId, label, true);
      }
      activateSlice(panelState, sliceId);
      updateSliceStatus(panelState, sliceId, 'starting...', debouncedRefresh);
      // Researcher phase — steering is acceptable (will be consumed at next round boundary)
      panelState.steeringAcceptable = true;
      debouncedRefresh();
    },

    onResearcherTokensHint: (id, inputTokens) => {
      const sliceId = id === 'quick' ? state.quickSliceLabel : id;
      const slice = panelState.slices.get(sliceId);
      if (slice && inputTokens > (slice.tokens || 0)) {
        slice.tokens = inputTokens;
      }
      debouncedRefresh();
    },

    onResearcherProgress: (id, status, tokens, cost) => {
      const sliceId = id === 'quick' ? state.quickSliceLabel : id;
      const unitsPerResearcher = getUnitsPerResearcher();
      
      if (status !== undefined) {
        if (status.startsWith('done:')) {
            const toolName = status.slice(5);
            // Only clear status if it matches the current tool or if it's the specific tool that finished
            // For now, we clear it to signal progress, but preserve it if it's null
            updateSliceStatus(panelState, sliceId, undefined, debouncedRefresh);
            if (panelState.progress) {
                const current = progressCredits.get(id) ?? 0;
                // Increment for the first tool call (setup/search) OR any scrape batch
                const shouldIncrement = (current === 0) || (toolName === 'scrape');
                if (shouldIncrement && current + 1 <= unitsPerResearcher) {
                    panelState.progress.made += 1;
                    progressCredits.set(id, current + 1);
                }
            }
        } else if (status) {
            updateSliceStatus(panelState, sliceId, status, debouncedRefresh);
        }
      }
      if (tokens !== undefined && cost !== undefined) {
        // Per-slice display only; run totals live in the metrics registry.
        updateSliceTokens(panelState, sliceId, tokens, cost);
      }
      debouncedRefresh();
    },

    onResearcherComplete: (id, _report) => {
      const sliceId = id === 'quick' ? state.quickSliceLabel : id;
      if (panelState.progress) {
        const unitsPerResearcher = getUnitsPerResearcher();
        const current = progressCredits.get(id) ?? 0;
        const remaining = unitsPerResearcher - current;
        if (remaining > 0) {
          panelState.progress.made += remaining;
          progressCredits.set(id, unitsPerResearcher);
        }
      }
      completeSlice(panelState, sliceId);
      debouncedRefresh();
    },

    onResearcherFailure: (id, _error) => {
      const sliceId = id === 'quick' ? state.quickSliceLabel : id;
      if (panelState.progress) {
        const unitsPerResearcher = getUnitsPerResearcher();
        const current = progressCredits.get(id) ?? 0;
        const remaining = unitsPerResearcher - current;
        if (remaining > 0) {
          panelState.progress.made += remaining;
          progressCredits.set(id, unitsPerResearcher);
        }
      }
      // Terminal failed outcome — completeSlice(failed) marks it so the render draws it
      // distinctly (error color + "failed"), rather than the transient status field which
      // a completed slice suppresses (making a failure look identical to a success).
      completeSlice(panelState, sliceId, true);
      debouncedRefresh();
    },

    onToolResult: (researcherId, success) => {
      const sliceId = researcherId === 'quick' ? state.quickSliceLabel : researcherId;
      flashSlice(panelState, sliceId, success ? 'green' : 'red', debouncedRefresh);
    },

    onEvaluationStart: (_round) => {
      addSlice(panelState, 'eval', 'eval', false);
      activateSlice(panelState, 'eval');
      updateSliceStatus(panelState, 'eval', 'evaluating', debouncedRefresh);
      // Keep steering acceptable during evaluation. The running evaluator call
      // already captured its inputs, so a message entered now is queued and acted
      // on at the NEXT round start (the whole point of mid-run steering). Forcing
      // it false here is exactly when users steer — and diverted that steering to
      // a separate pi follow-up turn instead of the current run's next round.
      panelState.steeringAcceptable = true;
      debouncedRefresh();
    },

    onEvaluationProgress: (status) => {
      updateSliceStatus(panelState, 'eval', status, debouncedRefresh);
      debouncedRefresh();
    },

    onEvaluationTokens: (tokens, cost) => {
      // Per-slice display only; run totals live in the metrics registry.
      updateSliceTokens(panelState, 'eval', tokens, cost);
      debouncedRefresh();
    },

    onEvaluationDecision: (action, plan, round) => {
      completeSlice(panelState, 'eval');
      // Only clear completed researchers when returning final synthesis
      // On delegation, researchers stay visible while new round researchers are added
      if (action === 'synthesize') {
        clearCompletedResearchers(panelState);
      }
      if (panelState.progress) {
        const key = `eval.round.${round ?? panelState.slices.size}`;
        if (!progressCredits.has(key)) {
          panelState.progress.made += LEAD_EVAL_UNITS;
          progressCredits.set(key, LEAD_EVAL_UNITS);
        }
      }
      if (action === 'synthesize') {
        if (panelState.progress) panelState.progress.made = panelState.progress.expected;
        // Final synthesis — steering no longer acceptable
        panelState.steeringAcceptable = false;
      } else {
        // Delegation: prepare for new round's search → researchers → steering acceptable
        if (plan?.researchers && plan.researchers.length > 0 && panelState.progress) {
          const unitsPerResearcher = getUnitsPerResearcher();
          panelState.progress.expected += (plan.researchers.length * unitsPerResearcher) + LEAD_EVAL_UNITS;
        }
        panelState.steeringAcceptable = true;
      }
      debouncedRefresh();
    },

    onComplete: () => {
      if (panelState.progress) panelState.progress.made = panelState.progress.expected;
      panelState.steeringAcceptable = false;
      debouncedRefresh();
    },

    onError: () => {
      if (panelState.progress) panelState.progress.made = panelState.progress.expected;
      panelState.steeringAcceptable = false;
      debouncedRefresh();
    }
  };
}

/**
 * Create initial observer state
 */
export function createObserverState(): ObserverState {
  return {
    progressCredits: new Map<string, number>(),
    quickSliceLabel: '',
    idToNumberMap: new Map<string, string>(),
    unsubPulse: null,
    waveBaseFrame: 0,
  };
}

/**
 * Stop wave animation in the observer
 */
export function stopObserverWaveAnimation(state: ObserverState, panelState: ResearchPanelState): void {
  if (state.unsubPulse) {
    state.unsubPulse();
    state.unsubPulse = null;
  }
  panelState.waveFrame = undefined;
  panelState.waveColors = undefined;
}
