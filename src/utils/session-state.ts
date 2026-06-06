/**
 * Research Session State Management
 *
 * Tracks failures and state for multiple simultaneous research sessions,
 * scoped by parent Pi session to prevent cross-context interference.
 */

import { generateSessionId as generateUniqueSessionId } from './shared-links.ts';
import { logger } from '../logger.ts';
import { getConfig } from '../config.ts';
import type { ResearchPanelState } from '../types/research-panel-types.ts';

/**
 * State container for a single Pi session
 */
interface PiSessionState {
  /** Map of research run ID → array of failed researcher IDs */
  failures: Map<string, string[]>;
  /** Ordered list of research run IDs for TUI stacking (Index 0 = oldest/bottom-most) */
  order: string[];
  /** Registry of panel states for each research run */
  panels: Map<string, ResearchPanelState>;
  /** Registry of abort controllers for each active research run */
  aborts: Map<string, AbortController>;
  /** Subscribers for order changes in this Pi session */
  subscribers: Array<() => void>;
  /** Global debounce timer for this specific Pi session */
  refreshTimeout: NodeJS.Timeout | null;
  /** Single update function for the Master Widget of this Pi session */
  masterUpdate: (() => void) | null;
  /** Steering messages captured for this Pi session */
  steeringMessages: string[];
}

/**
 * Global map of Pi session ID → PiSessionState
 */
const piSessions = new Map<string, PiSessionState>();

/**
 * Normalize session ID to ensure consistent behavior with undefined/empty IDs
 */
export function normalizeSessionId(piSessionId: string | undefined | null): string {
  if (!piSessionId || piSessionId === 'undefined' || piSessionId === 'null') {
    return 'default';
  }
  return piSessionId;
}

/**
 * Get or create state for a specific Pi session
 */
function getPiState(piSessionId: string | undefined): PiSessionState {
  const sid = normalizeSessionId(piSessionId);
  let state = piSessions.get(sid);
  if (!state) {
    state = {
      failures: new Map(),
      order: [],
      panels: new Map(),
      aborts: new Map(),
      subscribers: [],
      refreshTimeout: null,
      masterUpdate: null,
      steeringMessages: [],
    };
    piSessions.set(sid, state);
  }
  return state;
}

/**
 * Add a steering message to a Pi session
 */
export function addSteeringMessage(piSessionId: string | undefined, message: string): void {
  const sid = normalizeSessionId(piSessionId);
  const state = getPiState(sid);
  // Normalize whitespace to prevent functional duplicates
  const normalizedMsg = message.trim().replace(/\s+/g, ' ');
  const exists = state.steeringMessages.some(m => m.trim().replace(/\s+/g, ' ') === normalizedMsg);
  
  if (!exists) {
    logger.debug(`[session-state] Adding steering message to session ${sid}: ${message}`);
    state.steeringMessages.push(message);
    // CRITICAL: Trigger a TUI refresh when a steering message is added
    refreshAllSessions(sid);
  } else {
    logger.debug(`[session-state] Steering message already exists in session ${sid}: ${message}`);
  }
}

/**
 * Get all steering messages for a Pi session
 */
export function getSteeringMessages(piSessionId: string | undefined): string[] {
  const sid = normalizeSessionId(piSessionId);
  const messages = getPiState(sid).steeringMessages;
  logger.debug(`[session-state] Getting ${messages.length} steering messages for session ${sid}`);
  return [...messages];
}

/**
 * Get all currently tracked Pi session IDs (for diagnostics)
 */
export function getAllTrackedSessions(): string[] {
  return Array.from(piSessions.keys());
}

/**
 * Clear steering messages for a Pi session
 */
export function clearSteeringMessages(piSessionId: string | undefined): void {
  const sid = normalizeSessionId(piSessionId);
  const state = getPiState(sid);
  logger.debug(`[session-state] Clearing steering messages for session ${sid} (current count: ${state.steeringMessages.length})`);
  state.steeringMessages = [];
  refreshAllSessions(sid);
}

/**
 * Maximum allowed unique failed researchers before stopping research.
 * Set to 2 to balance thoroughness with resource conservation.
 */
export const MAX_FAILED_RESEARCHERS = 2;

/**
 * Subscribe to session order changes for a specific Pi session
 */
export function onSessionOrderChange(piSessionId: string | undefined, callback: () => void): () => void {
  const sid = normalizeSessionId(piSessionId);
  const state = getPiState(sid);
  state.subscribers.push(callback);
  return () => {
    // Avoid splice during iteration by making a copy before mutating if iterating.
    // Instead of raw splice, we create a new array or null out the entry.
    const index = state.subscribers.indexOf(callback);
    if (index !== -1) {
      state.subscribers.splice(index, 1);
    }
  };
}

/**
 * Notify subscribers of session order change
 */
function notifyOrderChange(piSessionId: string | undefined): void {
  const sid = normalizeSessionId(piSessionId);
  const state = getPiState(sid);
  // Make a shallow copy of subscribers to safely iterate if one unsubscribes
  const currentSubscribers = [...state.subscribers];
  for (const subscriber of currentSubscribers) {
    try {
      subscriber();
    } catch (error) {
      logger.error(`[session-state] Error in subscriber for ${sid}:`, error);
    }
  }
}

/**
 * Register a panel state for a research run
 */
export function registerSessionPanel(piSessionId: string | undefined, researchId: string, panel: ResearchPanelState): void {
  const sid = normalizeSessionId(piSessionId);
  const state = getPiState(sid);
  state.panels.set(researchId, panel);
  
  if (!state.order.includes(researchId)) {
    state.order.push(researchId);
    notifyOrderChange(sid);
  }
}

/**
 * Unregister a panel state
 */
export function unregisterSessionPanel(piSessionId: string | undefined, researchId: string): void {
  const sid = normalizeSessionId(piSessionId);
  const state = getPiState(sid);
  state.panels.delete(researchId);
}

/**
 * Register the update function for a Pi session's Master Widget
 */
export function registerMasterUpdate(piSessionId: string | undefined, update: () => void): void {
  const sid = normalizeSessionId(piSessionId);
  const state = getPiState(sid);
  state.masterUpdate = update;
}

/**
 * Refresh the Master Widget for a Pi session
 */
export function refreshAllSessions(piSessionId: string | undefined): void {
  const sid = normalizeSessionId(piSessionId);
  const state = getPiState(sid);

  // Clear existing timeout for this specific Pi session
  if (state.refreshTimeout) {
    clearTimeout(state.refreshTimeout);
  }

  const debounceMs = getConfig().TUI_REFRESH_DEBOUNCE_MS;
  state.refreshTimeout = setTimeout(() => {
    try {
      // Validate order integrity
      const validIds = state.order.filter(id => state.panels.has(id));

      if (validIds.length !== state.order.length) {
        for (const id of state.order) {
          if (!validIds.includes(id)) {
            state.failures.delete(id);
            state.panels.delete(id);
          }
        }
        state.order.length = 0;
        state.order.push(...validIds);
      }

      // Trigger the single Master Update for this Pi session
      if (state.masterUpdate) {
        try {
          state.masterUpdate();
        } catch (error) {
          logger.error(`[session-state] Error updating Master Widget for ${sid}:`, error);
        }
      }
    } finally {
      state.refreshTimeout = null;
    }
  }, debounceMs);
}

/**
 * Start a new research run within a Pi session
 */
export function startResearchSession(piSessionId: string | undefined, customResearchId?: string): string {
  const researchId = customResearchId || generateUniqueSessionId('research');
  const sid = normalizeSessionId(piSessionId);
  const state = getPiState(sid);
  state.failures.set(researchId, []);
  return researchId;
}

/**
 * Clear pending refreshes for a Pi session
 */
export function clearPendingRefresh(piSessionId: string | undefined): void {
  const sid = normalizeSessionId(piSessionId);
  const state = piSessions.get(sid);
  if (state?.refreshTimeout) {
    clearTimeout(state.refreshTimeout);
    state.refreshTimeout = null;
  }
}

/**
 * Register an abort controller for a research run so Esc can cancel all active runs at once.
 */
export function registerSessionAbort(piSessionId: string | undefined, researchId: string, controller: AbortController): void {
  const sid = normalizeSessionId(piSessionId);
  getPiState(sid).aborts.set(researchId, controller);
}

/**
 * Abort every active research run in a Pi session.
 * Called when the user presses Esc — cancels all concurrent sessions with a single keypress.
 */
export function abortAllSessions(piSessionId: string | undefined): void {
  const sid = normalizeSessionId(piSessionId);
  const state = piSessions.get(sid);
  if (!state) {
    logger.warn(`[session-state] No active session state found for abort request on ${sid}`);
    return;
  }
  
  const count = state.aborts.size;
  logger.info(`[session-state] Aborting ${count} research session(s) for ${sid}`);
  
  for (const controller of state.aborts.values()) {
    controller.abort();
  }
}

/**
 * End a research run
 */
export function endResearchSession(piSessionId: string | undefined, researchId: string): void {
  const sid = normalizeSessionId(piSessionId);
  const state = piSessions.get(sid);
  if (!state) return;

  state.failures.delete(researchId);
  state.panels.delete(researchId);
  state.aborts.delete(researchId);

  const index = state.order.indexOf(researchId);
  if (index !== -1) {
    state.order.splice(index, 1);
    notifyOrderChange(sid);
  }

  // If this was the last research run in the Pi session, clean up the state
  // Clear subscribers to prevent memory leak if they weren't properly unsubscribed
  if (state.order.length === 0 && state.panels.size === 0) {
    // Clear any remaining subscribers to allow cleanup
    if (state.subscribers.length > 0) {
      logger.warn(`[session-state] Clearing ${state.subscribers.length} remaining subscribers for ${sid} during session end`);
      state.subscribers = [];
    }
    clearPendingRefresh(sid);
    piSessions.delete(sid);
  }
}

/**
 * Clear all session state (for shutdown)
 */
export function clearAllSessionState(): void {
  for (const [, state] of piSessions.entries()) {
    // Clear all pending refreshes
    if (state.refreshTimeout) {
      clearTimeout(state.refreshTimeout);
      state.refreshTimeout = null;
    }
    // Clear all abort controllers
    for (const abort of state.aborts.values()) {
      try {
        abort.abort();
      } catch (e) {
        logger.error(`[session-state] Error aborting session:`, e);
      }
    }
  }
  // Clear all sessions
  piSessions.clear();
  logger.log('[session-state] All session state cleared');
}

/**
 * Check if a research run is the bottom-most in its Pi session
 */
export function isBottomMostSession(piSessionId: string | undefined, researchId: string): boolean {
  const sid = normalizeSessionId(piSessionId);
  const state = piSessions.get(sid);
  if (!state || state.order.length === 0) return false;
  return state.order[0] === researchId;
}

/**
 * Record a researcher failure
 */
export function recordResearcherFailure(piSessionId: string | undefined, researchId: string, researcherId: string): void {
  const sid = normalizeSessionId(piSessionId);
  const state = getPiState(sid);
  const failures = state.failures.get(researchId) || [];
  failures.push(researcherId);
  state.failures.set(researchId, failures);
}

/**
 * Get list of unique failed researchers in a research run
 */
export function getFailedResearchers(piSessionId: string | undefined, researchId: string): string[] {
  const sid = normalizeSessionId(piSessionId);
  const state = getPiState(sid);
  const failures = state.failures.get(researchId) || [];
  return [...new Set(failures)];
}

/**
 * Check if research should stop due to too many unique failures
 */
export function shouldStopResearch(piSessionId: string | undefined, researchId: string): boolean {
  const sid = normalizeSessionId(piSessionId);
  return getFailedResearchers(sid, researchId).length >= MAX_FAILED_RESEARCHERS;
}

/**
 * Get formatted error message for research stoppage
 */
export function getResearchStopMessage(piSessionId: string | undefined, researchId: string): string {
  const sid = normalizeSessionId(piSessionId);
  const failed = getFailedResearchers(sid, researchId);
  const count = failed.length;

  return [
    `Research stopped: ${count} researcher(s) failed: ${failed.join(', ')}.`,
    '',
    'This indicates infrastructure failure — multiple researchers could not complete research.',
    'Possible causes: network unavailable, search engine blocking automated requests.',
    '',
    '▎ If the health check passed (search and scrape verified), this failure is at the AI session layer —',
    '   check model availability, API key, and context settings.',
    '',
    'Troubleshooting:',
    '• Verify network connection is active',
    '• Check browser logs for automation detection signals',

    '• Check PI_RESEARCH_RESEARCHER_TIMEOUT_MS if set (default: 6 minutes)',
    '',
    'Partial results may be available below.',
  ].join('\n');
}

/**
 * Get all active research panels in a Pi session, in display order (newest first)
 */
export function getPiActivePanels(piSessionId: string | undefined): ResearchPanelState[] {
  const sid = normalizeSessionId(piSessionId);
  const state = piSessions.get(sid);
  if (!state) return [];
  // Return in reverse order (newest first) for top-to-bottom stacking in a single widget
  return [...state.order].reverse().map(id => state.panels.get(id)!).filter(Boolean);
}

/**
 * Get ordered list of active research runs in a Pi session
 */
export function getPiActiveSessionOrder(piSessionId: string | undefined): string[] {
  const sid = normalizeSessionId(piSessionId);
  const state = piSessions.get(sid);
  return state ? [...state.order] : [];
}

/**
 * Get the total count of all active research sessions across all Pi sessions.
 */
export function getActiveSessionCount(): number {
  let count = 0;
  for (const state of piSessions.values()) {
    count += state.order.length;
  }
  return count;
}

/**
 * Reset all state (for testing only)
 */
export function resetAllPiSessions(): void {
  for (const state of piSessions.values()) {
    if (state.refreshTimeout) {
      clearTimeout(state.refreshTimeout);
    }
  }
  piSessions.clear();
}
