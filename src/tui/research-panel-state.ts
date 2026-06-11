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
  FLASH_QUEUE_GAP_MS,
} from '../constants.ts';

// ---------------------------------------------------------------------------
// Flash queue internals
// ---------------------------------------------------------------------------

interface FlashEntry {
  color: 'green' | 'red';
}

interface SliceFlashState {
  activeColor: 'green' | 'red' | null;
  activeTimeout: NodeJS.Timeout | null;
  queue: FlashEntry[];
}

/** Per-session flash state: Map<sliceId, SliceFlashState> */
const sessionFlashState = new Map<string, Map<string, SliceFlashState>>();

function getOrCreateSliceFlash(sessionId: string, sliceId: string): SliceFlashState {
  let session = sessionFlashState.get(sessionId);
  if (!session) {
    session = new Map();
    sessionFlashState.set(sessionId, session);
  }
  let slice = session.get(sliceId);
  if (!slice) {
    slice = { activeColor: null, activeTimeout: null, queue: [] };
    session.set(sliceId, slice);
  }
  return slice;
}

/**
 * Clear all flash state for a session (call on session end).
 */
export function clearAllFlashTimeouts(sessionId?: string): void {
  if (sessionId) {
    const session = sessionFlashState.get(sessionId);
    if (session) {
      for (const slice of session.values()) {
        if (slice.activeTimeout) clearTimeout(slice.activeTimeout);
        slice.activeTimeout = null;
        slice.activeColor = null;
        slice.queue.length = 0;
      }
      sessionFlashState.delete(sessionId);
    }
  } else {
    for (const session of sessionFlashState.values()) {
      for (const slice of session.values()) {
        if (slice.activeTimeout) clearTimeout(slice.activeTimeout);
      }
    }
    sessionFlashState.clear();
  }
}

/**
 * Flash a researcher slice green or red.
 *
 * If a flash is already active for this slice the new entry is queued.
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

  const flash = getOrCreateSliceFlash(state.sessionId, sliceId);

  // If a flash is currently active, queue this one.
  if (flash.activeColor !== null) {
    flash.queue.push({ color });
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
    slice.flash = null;

    // Check queue
    if (flash.queue.length > 0 && !slice.completed) {
      const next = flash.queue.shift()!;
      // Small gap between flashes so they're visually distinct
      flash.activeTimeout = setTimeout(() => {
        startFlash(state, sliceId, flash, next.color, onUpdate);
      }, FLASH_QUEUE_GAP_MS);
    } else {
      onUpdate?.();
    }
  }, duration);
}

/** Clear flash state for a specific slice (called on complete/reactivate). */
function clearSliceFlash(sessionId: string, sliceId: string): void {
  const session = sessionFlashState.get(sessionId);
  if (!session) return;
  const flash = session.get(sliceId);
  if (!flash) return;
  if (flash.activeTimeout) clearTimeout(flash.activeTimeout);
  flash.activeTimeout = null;
  flash.activeColor = null;
  flash.queue.length = 0;
  session.delete(sliceId);
}

// ---------------------------------------------------------------------------
// Slice lifecycle
// ---------------------------------------------------------------------------

/**
 * Add a new researcher column
 */
export function addSlice(state: ResearchPanelState, id: string, label: string, queued: boolean = false): void {
  state.slices.set(id, { id, label, completed: false, queued, flash: null });
}

/**
 * Remove a researcher column
 */
export function removeSlice(state: ResearchPanelState, id: string): void {
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
 */
export function updateSliceStatus(state: ResearchPanelState, id: string, status: string | undefined): void {
  const slice = state.slices.get(id);
  if (slice) {
    slice.status = status;
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
    clearSliceFlash(state.sessionId, id);
  }
}

/**
 * Re-mark a researcher as active (used when promoting a completed researcher to lead evaluator)
 */
export function reactivateSlice(state: ResearchPanelState, id: string): void {
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
