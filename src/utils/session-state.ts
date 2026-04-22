/**
 * Research Session State Management
 *
 * Tracks failures and state for multiple simultaneous research sessions,
 * scoped by parent Pi session to prevent cross-context interference.
 */

import { generateSessionId as generateUniqueSessionId } from './shared-links.ts';
import { logger } from '../logger.ts';
import { getConfig } from '../config.ts';
import type { ResearchPanelState } from '../tui/research-panel.ts';

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
  /** Subscribers for order changes in this Pi session */
  subscribers: Array<() => void>;
  /** Global debounce timer for this specific Pi session */
  refreshTimeout: NodeJS.Timeout | null;
  /** Single update function for the Master Widget of this Pi session */
  masterUpdate: (() => void) | null;
}

/**
 * Global map of Pi session ID → PiSessionState
 */
const piSessions = new Map<string, PiSessionState>();

/**
 * Get or create state for a specific Pi session
 */
function getPiState(piSessionId: string): PiSessionState {
  let state = piSessions.get(piSessionId);
  if (!state) {
    state = {
      failures: new Map(),
      order: [],
      panels: new Map(),
      subscribers: [],
      refreshTimeout: null,
      masterUpdate: null,
    };
    piSessions.set(piSessionId, state);
  }
  return state;
}

/**
 * Maximum allowed unique failed researchers before stopping research
 */
const MAX_FAILED_RESEARCHERS = 2;

/**
 * Subscribe to session order changes for a specific Pi session
 */
export function onSessionOrderChange(piSessionId: string, callback: () => void): () => void {
  const state = getPiState(piSessionId);
  state.subscribers.push(callback);
  return () => {
    const index = state.subscribers.indexOf(callback);
    if (index !== -1) {
      state.subscribers.splice(index, 1);
    }
  };
}

/**
 * Notify subscribers of session order change
 */
function notifyOrderChange(piSessionId: string): void {
  const state = getPiState(piSessionId);
  for (const subscriber of state.subscribers) {
    try {
      subscriber();
    } catch (error) {
      logger.error(`[session-state] Error in subscriber for ${piSessionId}:`, error);
    }
  }
}

/**
 * Register a panel state for a research run
 */
export function registerSessionPanel(piSessionId: string, researchId: string, panel: ResearchPanelState): void {
  const state = getPiState(piSessionId);
  state.panels.set(researchId, panel);
  
  if (!state.order.includes(researchId)) {
    state.order.push(researchId);
    notifyOrderChange(piSessionId);
  }
}

/**
 * Unregister a panel state
 */
export function unregisterSessionPanel(piSessionId: string, researchId: string): void {
  const state = getPiState(piSessionId);
  state.panels.delete(researchId);
}

/**
 * Register the update function for a Pi session's Master Widget
 */
export function registerMasterUpdate(piSessionId: string, update: () => void): void {
  const state = getPiState(piSessionId);
  state.masterUpdate = update;
}

/**
 * Refresh the Master Widget for a Pi session
 */
export function refreshAllSessions(piSessionId: string): void {
  const state = getPiState(piSessionId);

  // Clear existing timeout for this specific Pi session
  if (state.refreshTimeout) {
    clearTimeout(state.refreshTimeout);
  }

  const debounceMs = getConfig().TUI_REFRESH_DEBOUNCE_MS;
  state.refreshTimeout = setTimeout(() => {
    try {
      // Validate order integrity
      const validIds = state.order.filter(id =>
        state.panels.has(id) && state.failures.has(id)
      );

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
          logger.error(`[session-state] Error updating Master Widget for ${piSessionId}:`, error);
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
export function startResearchSession(piSessionId: string): string {
  const researchId = generateUniqueSessionId('research');
  const state = getPiState(piSessionId);
  state.failures.set(researchId, []);
  return researchId;
}

/**
 * Clear pending refreshes for a Pi session
 */
export function clearPendingRefresh(piSessionId: string): void {
  const state = piSessions.get(piSessionId);
  if (state?.refreshTimeout) {
    clearTimeout(state.refreshTimeout);
    state.refreshTimeout = null;
  }
}

/**
 * End a research run
 */
export function endResearchSession(piSessionId: string, researchId: string): void {
  const state = piSessions.get(piSessionId);
  if (!state) return;

  state.failures.delete(researchId);
  state.panels.delete(researchId);

  const index = state.order.indexOf(researchId);
  if (index !== -1) {
    state.order.splice(index, 1);
    notifyOrderChange(piSessionId);
  }

  // If this was the last research run in the Pi session, clean up the state
  if (state.order.length === 0 && state.panels.size === 0 && state.subscribers.length === 0) {
    clearPendingRefresh(piSessionId);
    piSessions.delete(piSessionId);
  }
}

/**
 * Check if a research run is the bottom-most in its Pi session
 */
export function isBottomMostSession(piSessionId: string, researchId: string): boolean {
  const state = piSessions.get(piSessionId);
  if (!state || state.order.length === 0) return false;
  return state.order[0] === researchId;
}

/**
 * Record a researcher failure
 */
export function recordResearcherFailure(piSessionId: string, researchId: string, researcherId: string): void {
  const state = getPiState(piSessionId);
  const failures = state.failures.get(researchId) || [];
  failures.push(researcherId);
  state.failures.set(researchId, failures);
}

/**
 * Get list of unique failed researchers in a research run
 */
export function getFailedResearchers(piSessionId: string, researchId: string): string[] {
  const state = getPiState(piSessionId);
  const failures = state.failures.get(researchId) || [];
  return [...new Set(failures)];
}

/**
 * Check if research should stop due to too many unique failures
 */
export function shouldStopResearch(piSessionId: string, researchId: string): boolean {
  return getFailedResearchers(piSessionId, researchId).length >= MAX_FAILED_RESEARCHERS;
}

/**
 * Get formatted error message for research stoppage
 */
export function getResearchStopMessage(piSessionId: string, researchId: string): string {
  const failed = getFailedResearchers(piSessionId, researchId);
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
    '• Verify PROXY_URL if configured (optional): should be socks5://host:port or http://host:port',
    '• Check PI_RESEARCH_RESEARCHER_TIMEOUT_MS if set (default: 4 minutes)',
    '',
    'Partial results may be available below.',
  ].join('\n');
}

/**
 * Get all active research panels in a Pi session, in display order (newest first)
 */
export function getPiActivePanels(piSessionId: string): ResearchPanelState[] {
  const state = piSessions.get(piSessionId);
  if (!state) return [];
  // Return in reverse order (newest first) for top-to-bottom stacking in a single widget
  return [...state.order].reverse().map(id => state.panels.get(id)!).filter(Boolean);
}

/**
 * Get ordered list of active research runs in a Pi session
 */
export function getPiActiveSessionOrder(piSessionId: string): string[] {
  const state = piSessions.get(piSessionId);
  return state ? [...state.order] : [];
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
