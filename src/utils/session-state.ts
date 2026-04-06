/**
 * Research Session State Management
 *
 * Tracks failures and state for multiple simultaneous research sessions.
 */

import { generateSessionId as generateUniqueSessionId } from './shared-links.ts';
import { logger } from '../logger.ts';
import { getConfig } from '../config.ts';

/**
 * Map of session ID → array of failed researcher IDs
 */
const sessionFailures = new Map<string, string[]>();

/**
 * Ordered list of active session IDs for TUI stacking
 * Index 0 = oldest (bottom-most), Index N-1 = newest (top-most)
 */
const activeSessionOrder: string[] = [];

/**
 * Registry of update functions for each session to allow coordinated re-renders
 */
const sessionUpdateRegistry = new Map<string, () => void>();

/**
 * Subscribers for session order changes
 */
const orderChangeSubscribers: Array<() => void> = [];

/**
 * Maximum allowed unique failed researchers before stopping research
 */
const MAX_FAILED_RESEARCHERS = 2;

/**
 * Global debounce state for batching concurrent refresh calls
 * Ensures only one refresh executes at a time, preventing render order conflicts
 */
let globalRefreshPending = false;
let globalRefreshTimeout: NodeJS.Timeout | null = null;

/**
 * Subscribe to session order changes
 */
export function onSessionOrderChange(callback: () => void): () => void {
  orderChangeSubscribers.push(callback);
  return () => {
    const index = orderChangeSubscribers.indexOf(callback);
    if (index !== -1) {
      orderChangeSubscribers.splice(index, 1);
    }
  };
}

/**
 * Notify subscribers of session order change
 */
function notifyOrderChange(): void {
  // Execute all subscribers synchronously to ensure consistent state
  for (const subscriber of orderChangeSubscribers) {
    try {
      subscriber();
    } catch (error) {
      logger.error('Error in session order change subscriber:', error);
    }
  }
}

/**
 * Register an update function for a session
 */
export function registerSessionUpdate(sessionId: string, update: () => void): void {
  sessionUpdateRegistry.set(sessionId, update);
  
  // New sessions always go on top (end of the list)
  if (!activeSessionOrder.includes(sessionId)) {
    activeSessionOrder.push(sessionId);
    notifyOrderChange();
  }
}

/**
 * Unregister an update function for a session
 */
export function unregisterSessionUpdate(sessionId: string): void {
  sessionUpdateRegistry.delete(sessionId);
}

/**
 * Refresh all active sessions in their stable order
 * Uses global debouncing to batch concurrent refresh calls
 * Ensures only one refresh executes, preventing render order conflicts
 */
export function refreshAllSessions(): void {
  // If refresh already pending, skip - the pending one will use latest state
  if (globalRefreshPending) return;

  globalRefreshPending = true;

  // Clear any existing timeout to reset the debounce timer
  if (globalRefreshTimeout) {
    clearTimeout(globalRefreshTimeout);
  }

  // Debounce to batch concurrent calls (multiple sources trigger refreshes simultaneously)
  const debounceMs = getConfig().TUI_REFRESH_DEBOUNCE_MS;
  globalRefreshTimeout = setTimeout(() => {
    try {
      // Validate session order integrity before processing
      const validSessionIds = activeSessionOrder.filter(sessionId =>
        sessionUpdateRegistry.has(sessionId) && sessionFailures.has(sessionId)
      );

      // If we have invalid sessions, clean them up
      if (validSessionIds.length !== activeSessionOrder.length) {
        for (const sessionId of activeSessionOrder) {
          if (!validSessionIds.includes(sessionId)) {
            logger.warn(`[session-state] Cleaning up invalid session: ${sessionId}`);
            sessionFailures.delete(sessionId);
            unregisterSessionUpdate(sessionId);
          }
        }
        // Update order to only include valid sessions
        activeSessionOrder.length = 0;
        activeSessionOrder.push(...validSessionIds);
      }

      // Process from newest to oldest (top to bottom in TUI)
      // Render newest first (at the top), oldest last (at the bottom)
      for (let i = activeSessionOrder.length - 1; i >= 0; i--) {
        const sessionId = activeSessionOrder[i]!;
        const update = sessionUpdateRegistry.get(sessionId);
        if (update) {
          try {
            update();
          } catch (error) {
            logger.error(`Error updating session ${sessionId}:`, error);
          }
        }
      }
    } finally {
      globalRefreshPending = false;
      globalRefreshTimeout = null;
    }
  }, debounceMs);
}

/**
 * Get ordered list of active session IDs (oldest first, newest last)
 */
export function getActiveSessionOrder(): string[] {
  return [...activeSessionOrder];
}

/**
 * Start a new research session
 */
export function startResearchSession(): string {
  const sessionId = generateUniqueSessionId('research');
  sessionFailures.set(sessionId, []);
  // Note: activeSessionOrder.push happens in registerSessionUpdate
  return sessionId;
}

/**
 * Clear pending global refresh (used during cleanup)
 */
export function clearPendingRefresh(): void {
  if (globalRefreshTimeout) {
    clearTimeout(globalRefreshTimeout);
    globalRefreshTimeout = null;
  }
  globalRefreshPending = false;
}

/**
 * End a research session
 */
export function endResearchSession(sessionId: string): void {
  sessionFailures.delete(sessionId);
  unregisterSessionUpdate(sessionId);

  // Remove from order and maintain relative order of others
  const index = activeSessionOrder.indexOf(sessionId);
  if (index !== -1) {
    activeSessionOrder.splice(index, 1);
    notifyOrderChange();
  }
}

/**
 * Check if a session is the bottom-most active research session
 * (The one that should show the SearXNG status box)
 */
export function isBottomMostSession(sessionId: string): boolean {
  if (activeSessionOrder.length === 0) return false;
  return activeSessionOrder[0] === sessionId;  // First item in list is oldest/bottom-most
}

/**
 * Record a researcher failure
 */
export function recordResearcherFailure(sessionId: string, researcherId: string): void {
  const failures = sessionFailures.get(sessionId) || [];
  failures.push(researcherId);
  sessionFailures.set(sessionId, failures);
}

/**
 * Get list of unique failed researchers in a session
 */
export function getFailedResearchers(sessionId: string): string[] {
  const failures = sessionFailures.get(sessionId) || [];
  return [...new Set(failures)];
}

/**
 * Check if research should stop due to too many unique failures in a session
 */
export function shouldStopResearch(sessionId: string): boolean {
  return getFailedResearchers(sessionId).length >= MAX_FAILED_RESEARCHERS;
}

/**
 * Get formatted error message for research stoppage
 */
export function getResearchStopMessage(sessionId: string): string {
  const failed = getFailedResearchers(sessionId);
  const count = failed.length;

  return [
    `Research stopped: ${count} researcher(s) failed: ${failed.join(', ')}.`,
    '',
    'This indicates infrastructure failure — multiple researchers could not complete research.',
    'Possible causes: network unavailable, SearXNG container not running, search engines returning errors.',
    '',
    '▎ If the health check passed (search and scrape verified), this failure is at the AI session layer —',
    '   check model availability, API key, and context settings.',
    '',
    'Troubleshooting:',
    '• Verify network connection is active',
    '• Check SearXNG container: `docker ps | grep searxng`',
    '• View SearXNG logs: `docker logs pi-searxng` (check for engine HTTP errors like 503, 400)',
    '• Verify PROXY_URL if configured (optional): should be socks5://host:port or http://host:port',
    '• Check PI_RESEARCH_RESEARCHER_TIMEOUT_MS if set (default: 4 minutes)',
    '',
    'Partial results may be available below.',
  ].join('\n');
}

/**
 * Get all active sessions (for debugging)
 */
export function getAllSessions(): Map<string, number> {
  const result = new Map<string, number>();
  for (const [sessionId, failures] of sessionFailures.entries()) {
    const uniqueFailures = new Set(failures).size;
    result.set(sessionId, uniqueFailures);
  }
  return result;
}

