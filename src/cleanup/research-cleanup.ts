/**
 * Research Cleanup Module
 *
 * Handles cleanup operations for research sessions:
 * - Terminal input draining to prevent protocol response leaks
 * - Session and panel cleanup
 * - Shared links cleanup
 */

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { logger } from '../logger.ts';
import {
  endResearchSession,
  getPiActivePanels,
  refreshAllSessions,
} from '../orchestration/session-state.ts';
import { cleanupSharedLinks } from '../utils/shared-links.ts';
import type { CleanupContext } from '../types/index.ts';

export type { CleanupContext };

export interface CleanupDependencies {
  ctx: ExtensionContext;
}

export type CleanupFunction = () => Promise<void>;

/**
 * Create a cleanup function for a research session
 */
export function createCleanupFunction(
  cleanupCtx: CleanupContext,
  deps: CleanupDependencies
): CleanupFunction {
  const {
    researchId,
    piSessionId,
    masterWidgetId,
    unsubOrder,
  } = cleanupCtx;

  const { ctx } = deps;

  let cleanupCalled = false;

  // Use reference objects to allow updating after creation
  const unsubOrderContainer = cleanupCtx.unsubOrderRef || { value: unsubOrder };
  
  // Store reference objects in cleanup context for later updates
  if (!cleanupCtx.unsubOrderRef) {
    cleanupCtx.unsubOrderRef = unsubOrderContainer;
  }

  return async () => {
    if (cleanupCalled) return;
    cleanupCalled = true;

    if (unsubOrderContainer.value) {
      unsubOrderContainer.value();
      unsubOrderContainer.value = null;
    }

    endResearchSession(piSessionId, researchId);
    cleanupSharedLinks(researchId);

    // Clean up session-scoped logger to prevent unbounded Map growth.
    // Each research run creates a logger via getLogger(sessionId) that is
    // never removed otherwise.
    const { resetLogger } = await import('../logger.ts');
    resetLogger(researchId);
    
    // FIX (#10): Clear the session's browser circuit breaker to prevent unbounded
    // map growth. Breakers are keyed by the plain researchId — createResearchRunId()
    // generates it (`run-<8 hex>`) independently of piSessionId in
    // research-tool-definition.ts, and tools/scrape.ts / tools/search.ts thread that
    // same bare researchId into getBrowserCircuitBreaker() as BrowserTask.sessionId.
    // (The `${piSessionId}-<8 hex>` shape this comment used to assume is produced
    // only by generateSessionId(), which has no production caller.) This duplicates
    // the clearSessionCircuitBreaker(targetId) call research-orchestration-service.ts
    // already makes in its own finally block on the normal run-completion path; it
    // matters here on paths where this cleanup runs alone, e.g. a throw before
    // orchestrator.run() is ever reached.
    const { clearSessionCircuitBreaker } = await import('../infrastructure/browser/browser-error-utils.ts');
    clearSessionCircuitBreaker(researchId);
    
    const activePanels = getPiActivePanels(piSessionId);
    if (activePanels.length === 0) {
      // ctx.hasUI is a getter that throws "ctx is stale after session replacement or reload"
      // when the session was torn down mid-run (e.g. the user quit while research was in
      // flight). In that case there is no widget left to remove and no live UI to touch, so
      // treat it as no-UI rather than letting the throw surface as a scary "Cleanup failed".
      let hasUI = false;
      try { hasUI = ctx.hasUI; } catch { /* ctx stale (session closed mid-run) → treat as no UI */ }
      if (hasUI) {
        ctx.ui.setWidget(masterWidgetId, undefined);
        const tuiUI = ctx.ui as { setWorkingVisible?: (visible: boolean) => void };
        if (typeof tuiUI?.setWorkingVisible === 'function') {
          tuiUI.setWorkingVisible(true);
        }
      }
    } else {
      refreshAllSessions(piSessionId);
    }

    logger.info('[research] cleanup completed', { piSessionId, researchId });
  };
}

/**
 * Update the unsubOrder reference in the cleanup context
 */
export function updateUnsubOrder(cleanupCtx: CleanupContext, unsub: (() => void) | null): void {
  if (cleanupCtx.unsubOrderRef) {
    cleanupCtx.unsubOrderRef.value = unsub;
  }
}