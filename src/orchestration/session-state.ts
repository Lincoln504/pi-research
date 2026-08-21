/**
 * Research Session State Management
 *
 * Tracks failures and state for multiple simultaneous research sessions,
 * scoped by parent Pi session to prevent cross-context interference.
 */

import { generateSessionId as generateUniqueSessionId, clearAllSharedLinks } from '../utils/shared-links.ts';
import { logger } from '../logger.ts';
import { getConfig } from '../config.ts';
import type { ResearchPanelState } from '../types/research-panel-types.ts';
import type { SteeringMessage } from '../core/interfaces/steering-interfaces.ts';
import { randomUUID } from 'node:crypto';

export type { SteeringMessage, SteeringMessageStatus } from '../core/interfaces/steering-interfaces.ts';

/** Maximum number of steering messages per Pi session */
const MAX_STEERING_MESSAGES = 20;

/** Maximum length (chars) of a single steering message; longer input is truncated */
const MAX_STEERING_MESSAGE_LENGTH = 2000;

/**
 * State container for a single Pi session
 */
interface PiSessionState {
  /** Map of research run ID → array of failed researcher IDs */
  failures: Map<string, string[]>;
  /** Map of research run ID → (researcher ID → first failure reason) */
  failureReasons: Map<string, Map<string, string>>;
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
  /** Removes the Master Widget from the screen (used while a foreground menu is open) */
  masterRemove: (() => void) | null;
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
      failureReasons: new Map(),
      order: [],
      panels: new Map(),
      aborts: new Map(),
      subscribers: [],
      refreshTimeout: null,
      masterUpdate: null,
      masterRemove: null,
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

  // Cap per-message length. All active steering is re-sent to the evaluator every
  // round (up to MAX_STEERING_MESSAGES of them), so an unbounded message could
  // inflate the evaluator prompt toward the context ceiling and trigger timeouts.
  if (message.length > MAX_STEERING_MESSAGE_LENGTH) {
    message = message.slice(0, MAX_STEERING_MESSAGE_LENGTH);
  }

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
  
  // Enforce cap: evict the oldest non-popped message to make room. Prefer evicting
  // an oldest 'queued' message; if none are queued (every slot is 'active' from prior
  // rounds), evict the oldest 'active' one. Without the active fallback the new message
  // was pushed anyway, letting the array grow unbounded past MAX_STEERING_MESSAGES and
  // feeding ever more user text into evaluator prompts.
  if (state.steeringMessages.filter(m => m.status !== 'popped').length >= MAX_STEERING_MESSAGES) {
    let evictIdx = state.steeringMessages.findIndex(m => m.status === 'queued');
    if (evictIdx === -1) {
      evictIdx = state.steeringMessages.findIndex(m => m.status !== 'popped');
    }
    if (evictIdx !== -1) {
      logger.debug(`[session-state] Steering message cap reached, evicting oldest ${state.steeringMessages[evictIdx]!.status} message in session ${sid}`);
      state.steeringMessages.splice(evictIdx, 1);
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
 * Restore a previously-popped steering message back to 'queued'.
 * Called when forwarding a popped message to pi fails, so the user's input is
 * never silently lost — it stays poppable instead of vanishing.
 */
export function requeuePoppedMessage(piSessionId: string | undefined, messageId: string): void {
  const sid = normalizeSessionId(piSessionId);
  const state = piSessions.get(sid);
  if (!state) return;

  const msg = state.steeringMessages.find(m => m.id === messageId && m.status === 'popped');
  if (!msg) return;
  msg.status = 'queued';
  msg.poppedAt = null;
  logger.debug(`[session-state] Restored popped steering message to queued in session ${sid} (id: ${messageId})`);
  refreshAllSessions(sid);
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
 * Register the update function for a Pi session's Master Widget
 */
export function registerMasterUpdate(piSessionId: string | undefined, update: () => void): void {
  const sid = normalizeSessionId(piSessionId);
  const state = getPiState(sid);
  state.masterUpdate = update;
}

/**
 * Register the function that removes the Master Widget from the screen.
 * Used to fully hide the live research panel while a foreground interactive
 * menu (e.g. /research-config) is open, so the menu is not rendered cramped
 * beneath a tall, frozen research panel and leaves no ghost rows on close.
 */
export function registerMasterRemove(piSessionId: string | undefined, remove: () => void): void {
  const sid = normalizeSessionId(piSessionId);
  const state = getPiState(sid);
  state.masterRemove = remove;
}

/**
 * Immediately remove the Master Widget for a Pi session from the screen.
 * Cancels any pending debounced refresh so it cannot re-add the widget while
 * the menu is open. The widget is recreated from the preserved panel state via
 * refreshAllSessions() once the menu closes.
 */
export function hideMasterWidget(piSessionId: string | undefined): void {
  const sid = normalizeSessionId(piSessionId);
  const state = piSessions.get(sid);
  if (!state) return;
  if (state.refreshTimeout) {
    clearTimeout(state.refreshTimeout);
    state.refreshTimeout = null;
  }
  if (state.masterRemove) {
    try {
      state.masterRemove();
    } catch (error) {
      logger.error(`[session-state] Error removing Master Widget for ${sid}:`, error);
    }
  }
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
            state.failureReasons.delete(id);
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
 * Render the Master Widget for a Pi session *immediately*, bypassing the
 * debounce in refreshAllSessions().
 *
 * This is the animation path. The 100ms trailing debounce in
 * refreshAllSessions() is correct for low-frequency state changes (tokens,
 * status, slices) but starves the ~30 FPS wave pulse: each pulse resets the
 * timer before it can fire, so the wave never renders during continuous
 * animation. Animation frames must instead drive masterUpdate() directly and
 * rely on pi-tui's own render scheduler (MIN_RENDER_INTERVAL_MS=16ms throttle
 * + line-level differential rendering) to coalesce and cap the frame rate.
 *
 * Any pending debounced refresh is cancelled first so it cannot fire a
 * redundant render immediately after this one.
 */
export function flushMasterNow(piSessionId: string | undefined): void {
  const sid = normalizeSessionId(piSessionId);
  const state = piSessions.get(sid);
  if (!state) return;

  if (state.refreshTimeout) {
    clearTimeout(state.refreshTimeout);
    state.refreshTimeout = null;
  }

  if (state.masterUpdate) {
    try {
      state.masterUpdate();
    } catch (error) {
      logger.error(`[session-state] Error flushing Master Widget for ${sid}:`, error);
    }
  }
}

/**
 * Start a new research run within a Pi session
 */
export function startResearchSession(piSessionId: string | undefined, customResearchId?: string): string {
  const researchId = customResearchId || generateUniqueSessionId('research');
  const sid = normalizeSessionId(piSessionId);
  const state = getPiState(sid);
  state.failures.set(researchId, []);
  state.failureReasons.set(researchId, new Map());
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
 * End a research run
 */
export function endResearchSession(piSessionId: string | undefined, researchId: string): void {
  const sid = normalizeSessionId(piSessionId);
  const state = piSessions.get(sid);
  if (!state) return;

  state.failures.delete(researchId);
  state.failureReasons.delete(researchId);
  state.panels.delete(researchId);
  state.aborts.delete(researchId);

  const index = state.order.indexOf(researchId);
  if (index !== -1) {
    state.order.splice(index, 1);
    notifyOrderChange(sid);
  }

  // If this was the last research run in the Pi session, clean up the state
  // but preserve steering messages if any remain (they might arrive between
  // the last research end and the next research start).
  //
  // `state.aborts` is included alongside `order`/`panels`: those two are
  // populated ONLY by the TUI path (registerSessionPanel), so for a purely
  // headless multi-run session they are always empty — including while
  // OTHER headless runs are still genuinely active. Gating on order/panels
  // alone made this block treat every single headless run's end as "the
  // last one," which both cleared `aborts` for still-running siblings
  // (corrupting getActiveResearchRunCount for any caller relying on it) and,
  // combined with a caller that clears steering right after seeing count 0,
  // could wipe a message this very block had just decided to preserve one
  // statement earlier. `aborts.delete(researchId)` above already removed
  // this run's own entry, so `aborts.size === 0` here means no run of any
  // kind (TUI or headless) remains — the same atomic, single-synchronous-
  // function guarantee `order`/`panels` already had for the TUI-only case.
  if (state.order.length === 0 && state.panels.size === 0 && state.aborts.size === 0) {
    // Drop steering messages this run already consumed ('active') — and any
    // 'popped' remnants, which are likewise already resolved — before deciding
    // whether to keep the session alive. Without this, a message the run that
    // just ended already consumed stayed in the array and leaked into a later,
    // unrelated run's steering (both getActiveSteeringMessages/getSteeringMessages
    // reads and the before_agent_start injection gate), since nothing distinguishes
    // "steering for THIS run" from "steering already applied to a finished run".
    // Only messages still 'queued' (arrived in the gap, never attached to any run)
    // are genuinely eligible for the gap-preservation this block performs.
    state.steeringMessages = state.steeringMessages.filter(m => m.status === 'queued');

    // Only fully delete if there are no remaining steering messages
    const hasRemainingSteering = state.steeringMessages.length > 0;
    if (!hasRemainingSteering) {
      if (state.subscribers.length > 0) {
        state.subscribers = [];
      }
      clearPendingRefresh(sid);
      piSessions.delete(sid);
    } else {
      // Clear research-specific state but preserve the session and steering.
      // aborts is already empty (the outer gate above requires it), so no
      // separate clear is needed for it here.
      state.failures.clear();
      state.failureReasons.clear();
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
export function recordResearcherFailure(piSessionId: string | undefined, researchId: string, researcherId: string, reason?: string): void {
  const sid = normalizeSessionId(piSessionId);
  const state = getPiState(sid);
  const failures = state.failures.get(researchId) || [];
  failures.push(researcherId);
  state.failures.set(researchId, failures);
  if (reason) {
    const reasons = state.failureReasons.get(researchId) ?? new Map<string, string>();
    // Keep the FIRST reason per researcher — the root cause; retries repeat it.
    if (!reasons.has(researcherId)) reasons.set(researcherId, reason);
    state.failureReasons.set(researchId, reasons);
  }
}

/**
 * Get the recorded failure reason per failed researcher (first failure wins).
 */
export function getResearcherFailureReasons(piSessionId: string | undefined, researchId: string): Record<string, string> {
  const sid = normalizeSessionId(piSessionId);
  const state = getPiState(sid);
  const reasons = state.failureReasons.get(researchId);
  return reasons ? Object.fromEntries(reasons) : {};
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
 * Default (and fallback, for callers not passing a resolved Config) max allowed
 * unique failed researchers before the run aborts. Configurable per-run via
 * Config.MAX_FAILED_RESEARCHERS / PI_RESEARCH_MAX_FAILED_RESEARCHERS.
 */
const DEFAULT_MAX_FAILED_RESEARCHERS = 2;

/**
 * Check if research should stop due to too many unique failures
 */
export function shouldStopResearch(piSessionId: string | undefined, researchId: string, maxFailedResearchers: number = DEFAULT_MAX_FAILED_RESEARCHERS): boolean {
  const sid = normalizeSessionId(piSessionId);
  return getFailedResearchers(sid, researchId).length >= maxFailedResearchers;
}

/**
 * Get formatted error message for research stoppage
 */
export function getResearchStopMessage(piSessionId: string | undefined, researchId: string): string {
  const sid = normalizeSessionId(piSessionId);
  const failed = getFailedResearchers(sid, researchId);
  const count = failed.length;

  // Order the causes by likelihood. The pre-run health check verifies search and
  // scrape BEFORE researchers run, so when it passed (the normal case) the browser
  // and network are fine and the failure is at the model / AI-session layer — most
  // often a small or "thinking-only" model that returns no final answer after its
  // tool calls, or repeated ungrounded reports. Leading with "infrastructure /
  // search engine blocking" here mis-sends the user to debug their network; the
  // readiness probes do not even run a search, so a failure is not evidence of bot
  // blocking.
  // Lead with the RECORDED errors when we have them — the actual root cause
  // (e.g. a provider 429) beats generic guidance every time.
  const state = getPiState(sid);
  const reasons = state.failureReasons.get(researchId);
  const recorded = reasons && reasons.size > 0
    ? ['Recorded errors:', ...[...reasons].map(([id, r]) => `• researcher ${id}: ${r}`), '']
    : [];

  return [
    `Research stopped: ${count} researcher(s) did not return a usable report: ${failed.join(', ')}.`,
    '',
    ...recorded,
    'Most likely cause — the research model could not produce grounded results:',
    '• Try a more capable research model. Very small or "thinking-only" models often',
    '  emit no final text after their tool calls, which fails every researcher.',
    '• Verify the model is available and the API key / context settings are valid.',
    '',
    'Less likely — a network or browser problem (only if the health check did NOT pass):',
    '• Verify the network connection is active.',
    '• Check PI_RESEARCH_TIMEOUT_MS if set (default: 5 minutes).',
    '  A readiness-probe timeout is not a sign the search engine is blocking automated traffic.',
    '',
    'Partial results may be available below.',
  ].join('\n');
}

/**
 * Stable error code for a fail-fast research-stop error. cli.ts's reportError()
 * checks this BEFORE its 'api key'-substring config-error heuristic: the
 * boilerplate advice line above ("...API key / context settings are valid.")
 * is appended to every research-stop message regardless of cause, so a
 * substring match alone misclassifies every worker-pool/infra-driven stop as
 * a config error (exit 78) instead of a software error (exit 70).
 */
export const RESEARCH_STOPPED_ERROR_CODE = 'RESEARCH_STOPPED';

/**
 * Build the Error to throw when shouldStopResearch() trips, tagged with
 * RESEARCH_STOPPED_ERROR_CODE so callers can classify it without re-parsing
 * the (human-oriented, boilerplate-laden) message text.
 */
export function createResearchStopError(piSessionId: string | undefined, researchId: string): Error & { code: string } {
  const err = new Error(getResearchStopMessage(piSessionId, researchId)) as Error & { code: string };
  err.code = RESEARCH_STOPPED_ERROR_CODE;
  return err;
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
 * Count of research runs currently active in a Pi session, TUI or headless.
 *
 * Unlike getPiActivePanels (populated only by registerSessionPanel, which the
 * TUI path alone calls), `aborts` is registered by registerSessionAbort on
 * EVERY run — headless included — and removed only by endResearchSession. Use
 * this wherever "am I the last/only active run in this session" must hold for
 * headless callers too (e.g. gating a shared-state clear like steering
 * messages so a finishing run doesn't wipe a concurrent sibling's).
 */
export function getActiveResearchRunCount(piSessionId: string | undefined): number {
  const sid = normalizeSessionId(piSessionId);
  const state = piSessions.get(sid);
  return state ? state.aborts.size : 0;
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
