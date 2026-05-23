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

import type { ResearchObserver } from '../orchestration/research-observer.ts';
import { getUnitsPerResearcher, LEAD_EVAL_UNITS } from '../constants.ts';
import {
  addSlice,
  activateSlice,
  completeSlice,
  removeSlice,
  updateSliceTokens,
  updateSliceStatus,
  reactivateSlice,
  clearCompletedResearchers,
} from '../tui/research-panel.ts';

export interface ObserverContext {
  panelState: any;
  debouncedRefresh: () => void;
  researchComplexity: number;
}

export interface ObserverState {
  progressCredits: Map<string, number>;
  quickSliceLabel: string;
  waveTimer: NodeJS.Timeout | null;
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
  
  const {
    progressCredits,
    waveTimer,
  } = state;

  return {
    onStart: (query, complexity) => {
      if (complexity === 0) {
        const truncatedQuery = query.length > 20 ? query.slice(0, 20) + '...' : query;
        state.quickSliceLabel = `researching: ${truncatedQuery}`;
        addSlice(panelState, state.quickSliceLabel, state.quickSliceLabel, false);
        activateSlice(panelState, state.quickSliceLabel);
        updateSliceStatus(panelState, state.quickSliceLabel, 'Researching...');
        
        const units = getUnitsPerResearcher();
        panelState.progress = { expected: units, made: 0 };
      }
      debouncedRefresh();
    },

    onPlanningStart: (attempt) => {
      if (attempt === 1) {
        addSlice(panelState, 'coord', `coordinator`, false);
        activateSlice(panelState, 'coord');
      }
      updateSliceStatus(panelState, 'coord', attempt > 1 ? `Planning (retry ${attempt-1})...` : 'Planning...');
      debouncedRefresh();
    },

    onPlanningProgress: (status) => {
      updateSliceStatus(panelState, 'coord', status);
      debouncedRefresh();
    },

    onPlanningTokens: (tokens, cost) => {
      panelState.totalCost += cost;
      updateSliceTokens(panelState, 'coord', tokens, cost);
      panelState.totalTokens += tokens;
      debouncedRefresh();
    },

    onPlanningSuccess: (plan) => {
      completeSlice(panelState, 'coord');
      const unitsPerResearcher = getUnitsPerResearcher();
      const count = plan.researchers?.length || 0;
      const units = (count * unitsPerResearcher) + LEAD_EVAL_UNITS;
      panelState.progress = { expected: units, made: 0 };
      debouncedRefresh();
    },

    onRoundStart: (round) => {
      // Mark that we need to clear completed slices once the next round's researchers start.
      // This keeps previous round findings visible during the evaluation and search burst phases.
      if (round > 1) {
        (panelState as any).needsClear = true;
      }
    },

    onSearchStart: (_queries) => {
      let sliceId = 'coord';
      const hasEval = panelState.slices.has('eval');
      const hasCoord = panelState.slices.has('coord');
      
      if (state.quickSliceLabel) {
         sliceId = state.quickSliceLabel;
      } else if (hasEval || !hasCoord) {
         // Use eval if it already exists (from a previous round's evaluation)
         // or if coord is missing (removed after Round 1 started).
         sliceId = 'eval';
         // Always add/reset slice to ensure it's fresh (clear previous round tokens/cost)
         addSlice(panelState, 'eval', 'eval', false);
      }

      if (panelState.slices.has(sliceId)) {
          reactivateSlice(panelState, sliceId);
          activateSlice(panelState, sliceId); // Ensure not queued
      }
      updateSliceStatus(panelState, sliceId, 'Searching...');
      panelState.isSearching = true;

      // Start wave animation timer
      panelState.waveFrame = 0;
      if (waveTimer) clearInterval(waveTimer);
      (state as any).waveTimer = setInterval(() => {
        if (!panelState.isSearching) {
          clearInterval((state as any).waveTimer!);
          (state as any).waveTimer = null;
          return;
        }
        panelState.waveFrame = (panelState.waveFrame ?? 0) + 1;
        debouncedRefresh();
      }, 80); // 80ms = 12.5 FPS

      debouncedRefresh();
    },

    onSearchProgress: (count) => {
      let sliceId = 'coord';
      const hasEval = panelState.slices.has('eval');
      const hasCoord = panelState.slices.has('coord');

      if (state.quickSliceLabel) {
          sliceId = state.quickSliceLabel;
      } else if (hasEval || !hasCoord) {
          sliceId = 'eval';
      }
      
      updateSliceStatus(panelState, sliceId, `${count} Results`);
      debouncedRefresh();
    },

    onSearchComplete: (count) => {
      panelState.isSearching = false;

      // Stop wave animation timer
      if ((state as any).waveTimer) {
        clearInterval((state as any).waveTimer);
        (state as any).waveTimer = null;
      }
      panelState.waveFrame = undefined;
      panelState.waveColors = undefined; // Clear persistent colors for next search

      let sliceId = 'coord';
      const hasEval = panelState.slices.has('eval');
      const hasCoord = panelState.slices.has('coord');
      if (state.quickSliceLabel) {
          sliceId = state.quickSliceLabel;
      } else if (hasEval || !hasCoord) {
          sliceId = 'eval';
      }
      
      updateSliceStatus(panelState, sliceId, `${count} Results`);

      if (panelState.slices.has('coord')) {
        completeSlice(panelState, 'coord');
      } else if (!state.quickSliceLabel && panelState.slices.has('eval')) {
        // Search burst for next round used eval slice
        completeSlice(panelState, 'eval');
      }
      debouncedRefresh();
    },

    onResearcherStart: (id, _name, _goal, _roundNumber) => {
      if (panelState.slices.get('coord')?.completed) removeSlice(panelState, 'coord');
      if (panelState.slices.get('eval')?.completed) removeSlice(panelState, 'eval');

      // Deferred clearing: remove researchers from previous rounds only when the
      // first researcher of the current round starts.
      if ((panelState as any).needsClear) {
        clearCompletedResearchers(panelState);
        (panelState as any).needsClear = false;
      }

      // Researchers from previous rounds are cleared above
      const displayNum = id === 'quick' ? state.quickSliceLabel : id.replace(/^r/, '');
      
      // FIX: Prevent overwriting existing slice (prevents status flicker in Quick Research)
      if (!panelState.slices.has(displayNum)) {
        addSlice(panelState, displayNum, displayNum, true);
      }
      activateSlice(panelState, displayNum);
      debouncedRefresh();
    },

    onResearcherProgress: (id, status, tokens, cost) => {
      const displayNum = id === 'quick' ? state.quickSliceLabel : id.replace(/^r/, '');
      const unitsPerResearcher = getUnitsPerResearcher();
      
      if (status !== undefined) {
        if (status.startsWith('done:')) {
            const toolName = status.slice(5);
            // Only clear status if it matches the current tool or if it's the specific tool that finished
            // For now, we clear it to signal progress, but preserve it if it's null
            updateSliceStatus(panelState, displayNum, undefined);
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
            updateSliceStatus(panelState, displayNum, status);
        }
      }
      if (tokens !== undefined && cost !== undefined) {
        panelState.totalCost += cost;
        updateSliceTokens(panelState, displayNum, tokens, cost);
        panelState.totalTokens += tokens;
      }
      debouncedRefresh();
    },

    onResearcherComplete: (id, _report) => {
      const displayNum = id === 'quick' ? state.quickSliceLabel : id.replace(/^r/, '');
      if (panelState.progress) {
        const unitsPerResearcher = getUnitsPerResearcher();
        const current = progressCredits.get(id) ?? 0;
        const remaining = unitsPerResearcher - current;
        if (remaining > 0) {
          panelState.progress.made += remaining;
          progressCredits.set(id, unitsPerResearcher);
        }
      }
      completeSlice(panelState, displayNum);
      debouncedRefresh();
    },

    onResearcherFailure: (id) => {
      const displayNum = id === 'quick' ? state.quickSliceLabel : id.replace(/^r/, '');
      if (panelState.progress) {
        const unitsPerResearcher = getUnitsPerResearcher();
        const current = progressCredits.get(id) ?? 0;
        const remaining = unitsPerResearcher - current;
        if (remaining > 0) {
          panelState.progress.made += remaining;
          progressCredits.set(id, unitsPerResearcher);
        }
      }
      updateSliceStatus(panelState, displayNum, 'Failed');
      completeSlice(panelState, displayNum);
      debouncedRefresh();
    },

    onEvaluationStart: (_round) => {
      addSlice(panelState, 'eval', 'eval', false);
      activateSlice(panelState, 'eval');
      updateSliceStatus(panelState, 'eval', 'eval');
      debouncedRefresh();
    },

    onEvaluationProgress: (status) => {
      updateSliceStatus(panelState, 'eval', status);
      debouncedRefresh();
    },

    onEvaluationTokens: (tokens, cost) => {
      panelState.totalCost += cost;
      updateSliceTokens(panelState, 'eval', tokens, cost);
      panelState.totalTokens += tokens;
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
      } else {
        // Delegation: prepare for new round's researchers
        if (plan?.researchers && plan.researchers.length > 0 && panelState.progress) {
          const unitsPerResearcher = getUnitsPerResearcher();
          panelState.progress.expected += (plan.researchers.length * unitsPerResearcher) + LEAD_EVAL_UNITS;
        }
      }
      debouncedRefresh();
    },

    onComplete: () => {
      if (panelState.progress) panelState.progress.made = panelState.progress.expected;
      debouncedRefresh();
    },

    onError: () => {
      if (panelState.progress) panelState.progress.made = panelState.progress.expected;
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
    waveTimer: null,
  };
}

/**
 * Stop wave animation in the observer
 */
export function stopObserverWaveAnimation(state: ObserverState, panelState: any): void {
  if (state.waveTimer) {
    clearInterval(state.waveTimer);
    state.waveTimer = null;
  }
  panelState.waveFrame = undefined;
  panelState.waveColors = undefined;
}