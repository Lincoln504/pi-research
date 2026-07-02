/**
 * Research Panel State Management
 *
 * Functions for managing research panel state, including
 * the per-slice flash queue for tool result feedback.
 */

import type {
  ResearchPanelState,
} from '../types/research-panel-types.ts';

import {
  FLASH_GREEN_DURATION_MS,
  FLASH_RED_DURATION_MS,
  FLASH_STATUS_DURATION_MS,
  FLASH_QUEUE_GAP_MS,
} from '../constants.ts';

// ---------------------------------------------------------------------------
// Flash queue internals
// ---------------------------------------------------------------------------

interface FlashEntry {
  color: 'green' | 'red';
}

interface SliceFlashState {
  /** Non-null when a color flash is active OR we are in the inter-flash gap. */
  activeTimeout: NodeJS.Timeout | null;
  /** The color currently being displayed. Null during inter-flash gap. */
  activeColor: 'green' | 'red' | null;
  colorQueue: FlashEntry[];

  /** Non-null when a status 'pop' is active OR we are in the inter-flash gap. */
  statusTimeout: NodeJS.Timeout | null;
  /** The status text currently being displayed. Null during inter-flash gap. */
  activeStatus: string | null;
  statusQueue: string[];
}

/**
 * Maximum queued items per slice.
 */
const MAX_QUEUE_SIZE = 8;

/**
 * Per-research-run flash state: Map<researchId, Map<sliceId, SliceFlashState>>.
 *
 * Keyed by researchId, NOT the pi sessionId: a single pi session can host several
 * concurrent research runs, and they all reuse the same slice ids ('coord', 'eval',
 * '1', '2', …). Keying by sessionId let one run's flashes render against — or, on
 * teardown, cancel — another run's, sometimes leaving a column stuck colored.
 * researchId is unique per run, so this isolates them.
 */
const flashStateByRun = new Map<string, Map<string, SliceFlashState>>();

function getOrCreateSliceFlash(researchId: string, sliceId: string): SliceFlashState {
  let run = flashStateByRun.get(researchId);
  if (!run) {
    run = new Map();
    flashStateByRun.set(researchId, run);
  }
  let slice = run.get(sliceId);
  if (!slice) {
    slice = {
      activeColor: null,
      activeTimeout: null,
      colorQueue: [],
      activeStatus: null,
      statusTimeout: null,
      statusQueue: []
    };
    run.set(sliceId, slice);
  }
  return slice;
}

/**
 * Clear all flash state for a research run (call on that run's teardown). Scoped to
 * the run so disposing one run never cancels a concurrent sibling run's flashes.
 */
export function clearAllFlashTimeouts(researchId?: string): void {
  if (researchId) {
    const run = flashStateByRun.get(researchId);
    if (run) {
      for (const slice of run.values()) {
        if (slice.activeTimeout) clearTimeout(slice.activeTimeout);
        if (slice.statusTimeout) clearTimeout(slice.statusTimeout);
        slice.activeTimeout = null;
        slice.activeColor = null;
        slice.colorQueue.length = 0;
        slice.statusTimeout = null;
        slice.activeStatus = null;
        slice.statusQueue.length = 0;
      }
      flashStateByRun.delete(researchId);
    }
  } else {
    for (const run of flashStateByRun.values()) {
      for (const slice of run.values()) {
        if (slice.activeTimeout) clearTimeout(slice.activeTimeout);
        if (slice.statusTimeout) clearTimeout(slice.statusTimeout);
      }
    }
    flashStateByRun.clear();
  }
}

/**
 * Flash a researcher slice green or red.
 *
 * If a flash or gap is currently active for this slice the new entry is queued.
 * Each queued flash plays after the previous one expires plus a small gap
 * so rapid-fire per-URL results are visible as distinct pulses.
 */
export function flashSlice(
  state: ResearchPanelState,
  sliceId: string,
  color: 'green' | 'red',
  onUpdate?: () => void,
): void {
  const slice = state.slices.get(sliceId);
  if (!slice || slice.completed || slice.queued) return;

  const flash = getOrCreateSliceFlash(state.researchId, sliceId);

  if (flash.activeTimeout !== null) {
    if (flash.colorQueue.length < MAX_QUEUE_SIZE) {
      flash.colorQueue.push({ color });
    }
    return;
  }

  startFlash(state, sliceId, flash, color, onUpdate);
}

function startFlash(
  state: ResearchPanelState,
  sliceId: string,
  flash: SliceFlashState,
  color: 'green' | 'red',
  onUpdate?: () => void,
): void {
  const slice = state.slices.get(sliceId);
  if (!slice || slice.completed) return;

  const duration = color === 'green' ? FLASH_GREEN_DURATION_MS : FLASH_RED_DURATION_MS;

  flash.activeColor = color;
  slice.flash = color;
  onUpdate?.();

  flash.activeTimeout = setTimeout(() => {
    flash.activeColor = null;
    flash.activeTimeout = null;

    const currentSlice = state.slices.get(sliceId);
    if (currentSlice) currentSlice.flash = null;

    if (flash.colorQueue.length > 0) {
      const currentSliceCheck = state.slices.get(sliceId);
      if (currentSliceCheck && !currentSliceCheck.completed) {
        const next = flash.colorQueue.shift()!;
        flash.activeTimeout = setTimeout(() => {
          startFlash(state, sliceId, flash, next.color, onUpdate);
        }, FLASH_QUEUE_GAP_MS);
        onUpdate?.();
        return;
      }
    }
    onUpdate?.();
  }, duration);
}

/**
 * Flash a status message (tool name) in the researcher box for a fixed duration.
 */
export function flashStatus(
  state: ResearchPanelState,
  sliceId: string,
  status: string,
  onUpdate?: () => void,
): void {
  const slice = state.slices.get(sliceId);
  if (!slice || slice.completed || slice.queued) return;

  const flash = getOrCreateSliceFlash(state.researchId, sliceId);

  if (flash.statusTimeout !== null) {
    if (flash.statusQueue.length < MAX_QUEUE_SIZE) {
      flash.statusQueue.push(status);
    }
    return;
  }

  startStatusPop(state, sliceId, flash, status, onUpdate);
}

function startStatusPop(
  state: ResearchPanelState,
  sliceId: string,
  flash: SliceFlashState,
  status: string,
  onUpdate?: () => void,
): void {
  const slice = state.slices.get(sliceId);
  if (!slice || slice.completed) return;

  flash.activeStatus = status;
  slice.status = status;
  onUpdate?.();

  flash.statusTimeout = setTimeout(() => {
    flash.activeStatus = null;
    flash.statusTimeout = null;

    const currentSlice = state.slices.get(sliceId);
    if (currentSlice) currentSlice.status = undefined;

    if (flash.statusQueue.length > 0) {
      const currentSliceCheck = state.slices.get(sliceId);
      if (currentSliceCheck && !currentSliceCheck.completed) {
        const next = flash.statusQueue.shift()!;
        flash.statusTimeout = setTimeout(() => {
          startStatusPop(state, sliceId, flash, next, onUpdate);
        }, FLASH_QUEUE_GAP_MS);
        onUpdate?.();
        return;
      }
    }
    onUpdate?.();
  }, FLASH_STATUS_DURATION_MS);
}

/**
 * Clean up flash state for a specific slice.
 * Clears timeout, queue, and removes from the session map.
 */
function clearSliceFlash(researchId: string, sliceId: string): void {
  const run = flashStateByRun.get(researchId);
  if (!run) return;
  const flash = run.get(sliceId);
  if (!flash) return;
  if (flash.activeTimeout) clearTimeout(flash.activeTimeout);
  if (flash.statusTimeout) clearTimeout(flash.statusTimeout);
  flash.activeTimeout = null;
  flash.activeColor = null;
  flash.colorQueue.length = 0;
  flash.statusTimeout = null;
  flash.activeStatus = null;
  flash.statusQueue.length = 0;
  run.delete(sliceId);
}

// ---------------------------------------------------------------------------
// Slice lifecycle
// ---------------------------------------------------------------------------

/**
 * Add a new researcher column.
 * If a slice with this id already exists, any leftover flash state is cleaned up.
 */
export function addSlice(state: ResearchPanelState, id: string, label: string, queued: boolean = false): void {
  // Clean up any leftover flash state from a previous slice with the same id
  // (e.g., 'eval' being re-added across evaluation rounds).
  clearSliceFlash(state.researchId, id);
  state.slices.set(id, { id, label, completed: false, queued, flash: null });
}

/**
 * Remove a researcher column.
 * Cleans up any flash state to prevent orphaned timers.
 */
export function removeSlice(state: ResearchPanelState, id: string): void {
  clearSliceFlash(state.researchId, id);
  state.slices.delete(id);
}

/**
 * Mark researcher as active (start from queued state)
 */
export function activateSlice(state: ResearchPanelState, id: string): void {
  const slice = state.slices.get(id);
  if (slice) slice.queued = false;
}

/**
 * Update researcher tokens and cost.
 * Tokens are treated as current context size (latest value), while cost is accumulated.
 */
export function updateSliceTokens(state: ResearchPanelState, id: string, tokens: number, cost: number): void {
  const slice = state.slices.get(id);
  if (slice) {
    // Non-decreasing guard: never update with a lower token count (stale estimates)
    if (tokens > (slice.tokens || 0)) {
        slice.tokens = tokens;
    }
    // Cost is accumulated by adding the new cost to the existing cost
    slice.cost = (slice.cost || 0) + cost;
  }
}

/**
 * Update researcher status message (e.g. "Searching...")
 * For researchers, this uses flashStatus to provide timed "pops" of tool names.
 */
export function updateSliceStatus(state: ResearchPanelState, id: string, status: string | undefined, onUpdate?: () => void): void {
  const slice = state.slices.get(id);
  if (!slice) return;

  // For researchers (numeric labels or 'quick' slice), use the timed pop logic
  // for non-empty status strings. This makes fast tool names visible.
  // Core agents (coord/eval) keep persistent statuses for long-running phases.
  const isResearcher = !isNaN(parseInt(slice.label, 10)) || slice.id.includes('researching:');
  
  if (status && isResearcher) {
    flashStatus(state, id, status, onUpdate);
  } else {
    slice.status = status;
    if (onUpdate) onUpdate();
  }
}

/**
 * Mark researcher as complete
 */
export function completeSlice(state: ResearchPanelState, id: string): void {
  const slice = state.slices.get(id);
  if (slice) {
    slice.completed = true;
    slice.queued = false;
    slice.flash = null;
    clearSliceFlash(state.researchId, id);
  }
}

/**
 * Re-mark a researcher as active (used when promoting a completed researcher to lead evaluator).
 * Cleans up any leftover flash state from the previous lifecycle phase.
 */
export function reactivateSlice(state: ResearchPanelState, id: string): void {
  // Clean up any flash state from the previous lifecycle (timers, queue).
  clearSliceFlash(state.researchId, id);
  const slice = state.slices.get(id);
  if (slice) {
    slice.completed = false;
    slice.flash = null;
  }
}

/**
 * Clear all completed slices from the TUI panel.
 * This includes researchers, coordinator, and evaluator once completed.
 */
export function clearCompletedResearchers(state: ResearchPanelState): void {
  const toRemove: string[] = [];
  for (const [id, slice] of state.slices.entries()) {
    if (slice.completed) {
      clearSliceFlash(state.researchId, id);
      toRemove.push(id);
    }
  }
  for (const id of toRemove) {
    state.slices.delete(id);
  }
}

/**
 * Create initial panel state for research session
 */
export function createInitialPanelState(sessionId: string, researchId: string, query: string, modelName: string): ResearchPanelState {
  return {
    sessionId,
    researchId,
    query,
    totalTokens: 0,
    totalCost: 0,
    slices: new Map(),
    modelName,
  };
}
