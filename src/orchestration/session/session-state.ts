/**
 * Research Session State Management
 *
 * Tracks failures and state for multiple simultaneous research sessions,
 * scoped by parent Pi session to prevent cross-context interference.
 */

import { generateSessionId as generateUniqueSessionId, clearAllSharedLinks } from '../../utils/shared-links.ts';
import { logger } from '../../logger.ts';
import { getConfig } from '../../config.ts';
import type { ResearchPanelState } from '../../types/research-panel-types.ts';
import { randomUUID } from 'node:crypto';

/**
 * Steering message status lifecycle:
 * queued → active (consumed by orchestrator) or queued → popped (removed by user via Alt+P)
 */
export type SteeringMessageStatus = 'queued' | 'active' | 'popped';

/**
 * A steering message captured during active research.
 */
export interface SteeringMessage {
  /** Unique identifier */
  id: string;
  /** The message text */
  text: string;
  /** Current lifecycle status */
  status: SteeringMessageStatus;
  /** Timestamp when the message was added */
  addedAt: number;
  /** Timestamp when the message was consumed (marked active) by the orchestrator */
  consumedAt: number | null;
  /** Timestamp when the message was popped by the user */
  poppedAt: number | null;
}

/** Maximum number of steering messages per Pi session */
const MAX_STEERING_MESSAGES = 20;

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
  steeringMessages: SteeringMessage[];
  /** Timestamp of the last global abort for this Pi session */
  lastAbortAt?: number;
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
      lastAbortAt: 0,
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
  
  // 1. Check for duplicates (already in queue or active)
  const exists = state.steeringMessages.some(
    m => m.status !== 'popped' && m.text.trim().replace(/\s+/g, ' ') === normalizedMsg
  );
  
  if (exists) {
    logger.debug(`[session-state] Steering message already exists in session ${sid}: ${message}`);
    return;
  }
  
  // Enforce cap: remove oldest queued message if at limit
  if (state.steeringMessages.filter(m => m.status !== 'popped').length >= MAX_STEERING_MESSAGES) {
    const oldestQueuedIdx = state.steeringMessages.findIndex(m => m.status === 'queued');
    if (oldestQueuedIdx !== -1) {
      logger.debug(`[session-state] Steering message cap reached, removing oldest queued in session ${sid}`);
      state.steeringMessages.splice(oldestQueuedIdx, 1);
    }
  }
    
    const steeringMsg: SteeringMessage = {
      id: randomUUID(),
      text: message,
      status: 'queued',
      addedAt: Date.now(),
      consumedAt: null,
      poppedAt: null,
    };
    
    logger.debug(`[session-state] Adding steering message to session ${sid}: ${message} (id: ${steeringMsg.id})`);
    state.steeringMessages.push(steeringMsg);
    
    // Trigger a TUI refresh when a steering message is added
    refreshAllSessions(sid);
}

/**
 * Get all currently tracked Pi session IDs (for diagnostics)
 */
export function getAllTrackedSessions(): string[] {
  return Array.from(piSessions.keys());
}

/**
 * Get all non-popped steering messages for a Pi session.
 * Returns SteeringMessage objects (full metadata).
 */
export function getSteeringMessages(piSessionId: string | undefined): SteeringMessage[] {
  const sid = normalizeSessionId(piSessionId);
  const state = piSessions.get(sid);
  if (!state) return [];
  return [...state.steeringMessages.filter(m => m.status !== 'popped')];
}

/**
 * Get only queued steering messages for a Pi session.
 * Used by the Alt+P pop handler to identify poppable messages.
 */
export function getQueuedSteeringMessages(piSessionId: string | undefined): SteeringMessage[] {
  const sid = normalizeSessionId(piSessionId);
  const state = piSessions.get(sid);
  if (!state) return [];
  return state.steeringMessages.filter(m => m.status === 'queued');
}

/**
 * Get only active (consumed) steering messages for a Pi session.
 * Used for the final report — only messages the LLM actually saw.
 */
export function getActiveSteeringMessages(piSessionId: string | undefined): SteeringMessage[] {
  const sid = normalizeSessionId(piSessionId);
  const state = piSessions.get(sid);
  if (!state) return [];
  return state.steeringMessages.filter(m => m.status === 'active');
}

/**
 * Consume all queued steering messages — atomically mark them as active.
 * Called by orchestrators at round start before passing messages to planning.
 * Returns the messages that were transitioned from queued to active.
 */
export function consumeQueuedMessages(piSessionId: string | undefined): SteeringMessage[] {
  const sid = normalizeSessionId(piSessionId);
  const state = piSessions.get(sid);
  if (!state) return [];
  
  const now = Date.now();
  const consumed: SteeringMessage[] = [];
  
  for (const msg of state.steeringMessages) {
    if (msg.status === 'queued') {
      msg.status = 'active';
      msg.consumedAt = now;
      consumed.push(msg);
    }
  }
  
  if (consumed.length > 0) {
    logger.debug(`[session-state] Consumed ${consumed.length} queued steering messages for session ${sid}`);
    refreshAllSessions(sid);
  }
  
  return consumed;
}

/**
 * Pop all queued steering messages — mark them as popped and return them.
 * Called by the Alt+P shortcut handler.
 * Returns the messages that were popped (for forwarding to pi's follow-up queue).
 */
export function popQueuedMessages(piSessionId: string | undefined): SteeringMessage[] {
  const sid = normalizeSessionId(piSessionId);
  const state = piSessions.get(sid);
  if (!state) return [];
  
  const now = Date.now();
  const popped: SteeringMessage[] = [];
  
  for (const msg of state.steeringMessages) {
    if (msg.status === 'queued') {
      msg.status = 'popped';
      msg.poppedAt = now;
      popped.push(msg);
    }
  }
  
  if (popped.length > 0) {
    logger.info(`[session-state] Popped ${popped.length} queued steering messages for session ${sid}`);
    refreshAllSessions(sid);
  }
  
  return popped;
}

/**
 * Clear all steering messages for a Pi session regardless of status.
 */
export function clearSteeringMessages(piSessionId: string | undefined): void {
  const sid = normalizeSessionId(piSessionId);
  const state = piSessions.get(sid);
  if (!state) return;
  
  logger.debug(`[session-state] Clearing steering messages for session ${sid} (current count: ${state.steeringMessages.length})`);
  state.steeringMessages = [];
  refreshAllSessions(sid);
}

/**
 * Check if there are any queued (poppable) steering messages for a Pi session.
 */
export function hasQueuedSteeringMessages(piSessionId: string | undefined): boolean {
  const sid = normalizeSessionId(piSessionId);
  const state = piSessions.get(sid);
  if (!state) return false;
  return state.steeringMessages.some(m => m.status === 'queued');
}

/**
 * Subscribe to session order changes for a specific Pi session
 */
export function onSessionOrderChange(piSessionId: string | undefined, callback: () => void): () => void {
  const sid = normalizeSessionId(piSessionId);
  const state = getPiState(sid);
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
function notifyOrderChange(piSessionId: string | undefined): void {
  const sid = normalizeSessionId(piSessionId);
  const state = getPiState(sid);
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

  if (state.refreshTimeout) {
    clearTimeout(state.refreshTimeout);
  }

  const debounceMs = getConfig().TUI_REFRESH_DEBOUNCE_MS;
  state.refreshTimeout = setTimeout(() => {
    try {
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
 * Register an abort controller for a research run
 */
export function registerSessionAbort(piSessionId: string | undefined, researchId: string, controller: AbortController): void {
  const sid = normalizeSessionId(piSessionId);
  getPiState(sid).aborts.set(researchId, controller);
}

/**
 * Abort every active research run in a Pi session.
 */
export function abortAllSessions(piSessionId: string | undefined): void {
  const sid = normalizeSessionId(piSessionId);
  const state = piSessions.get(sid);
  if (!state) return;
  
  state.lastAbortAt = Date.now();
  
  for (const controller of state.aborts.values()) {
    controller.abort();
  }
}

/**
 * Get the timestamp of the last global abort for a Pi session.
 */
export function getLastAbortAt(piSessionId: string | undefined): number {
  const sid = normalizeSessionId(piSessionId);
  return piSessions.get(sid)?.lastAbortAt ?? 0;
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
  // but preserve steering messages if any remain (they might arrive between
  // the last research end and the next research start)
  if (state.order.length === 0 && state.panels.size === 0) {
    // Only fully delete if there are no remaining steering messages
    const hasRemainingSteering = state.steeringMessages.length > 0;
    if (!hasRemainingSteering) {
      if (state.subscribers.length > 0) {
        state.subscribers = [];
      }
      clearPendingRefresh(sid);
      piSessions.delete(sid);
    } else {
      // Clear research-specific state but preserve the session and steering
      state.failures.clear();
      state.aborts.clear();
    }
  }
}

/**
 * Clear all session state (for shutdown)
 */
export function clearAllSessionState(): void {
  for (const [, state] of piSessions.entries()) {
    if (state.refreshTimeout) {
      clearTimeout(state.refreshTimeout);
      state.refreshTimeout = null;
    }
    for (const abort of state.aborts.values()) {
      try {
        abort.abort();
      } catch { /* ignore */ }
    }
  }
  piSessions.clear();
  clearAllSharedLinks();
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
 * Maximum allowed unique failed researchers
 */
export const MAX_FAILED_RESEARCHERS = 2;

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
    '• Check PI_RESEARCH_TIMEOUT_MS if set (default: 5 minutes)',
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
  return [...state.order].reverse().map(id => state.panels.get(id)!).filter(Boolean);
}

/**
 * Get the ordered list of active research run IDs in a Pi session.
 * Returns IDs in chronological order (oldest first, newest last).
 */
export function getPiActiveSessionOrder(piSessionId: string | undefined): string[] {
  const sid = normalizeSessionId(piSessionId);
  const state = piSessions.get(sid);
  if (!state) return [];
  return [...state.order];
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
