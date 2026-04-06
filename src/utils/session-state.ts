/**
 * Research Session State Management
 *
 * Tracks failures and state for multiple simultaneous research sessions.
 */

import { generateSessionId as generateUniqueSessionId } from './shared-links.ts';

/**
 * Map of session ID → array of failed researcher IDs
 */
const sessionFailures = new Map<string, string[]>();

/**
 * Ordered list of active session IDs for TUI stacking
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
  for (const subscriber of orderChangeSubscribers) {
    subscriber();
  }
}

/**
 * Register an update function for a session
 */
export function registerSessionUpdate(sessionId: string, update: () => void): void {
  sessionUpdateRegistry.set(sessionId, update);
  // Add to active order only when registered for updates
  // This ensures the first one to register becomes the bottom-most in TUI
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
 * This prevents panels from "switching places" in the TUI stack.
 */
export function refreshAllSessions(): void {
  for (const sessionId of activeSessionOrder) {
    const update = sessionUpdateRegistry.get(sessionId);
    if (update) {
      update();
    }
  }
}

/**
 * Get ordered list of active session IDs
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
 * End a research session
 */
export function endResearchSession(sessionId: string): void {
  sessionFailures.delete(sessionId);
  unregisterSessionUpdate(sessionId);
  const index = activeSessionOrder.indexOf(sessionId);
  if (index !== -1) {
    activeSessionOrder.splice(index, 1);
    notifyOrderChange();
  }
}

/**
 * Check if a session is the bottom-most active research session
 * (The one that should show the SearXNG status box)
 * 
 * In pi's TUI with 'aboveEditor' placement, widgets are rendered in the order
 * they are added. The last widget added is closest to the editor (bottom-most).
 */
export function isBottomMostSession(sessionId: string): boolean {
  if (activeSessionOrder.length === 0) return false;
  return activeSessionOrder[activeSessionOrder.length - 1] === sessionId;
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
