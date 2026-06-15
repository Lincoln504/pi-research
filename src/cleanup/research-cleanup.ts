/**
 * Research Cleanup Module
 *
 * Handles cleanup operations for research sessions:
 * - Terminal input draining to prevent protocol response leaks
 * - Wave animation timer cleanup
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
import type { ResearchPanelState } from '../types/research-panel-types.ts';

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
    panelState,
    waveTimer,
    unsubOrder,
  } = cleanupCtx;
  
  const { ctx } = deps;
  
  let cleanupCalled = false;
  let waveTimerRef = waveTimer;
  
  // Use reference objects to allow updating after creation
  const unsubOrderContainer = cleanupCtx.unsubOrderRef || { value: unsubOrder };
  
  // Store reference objects in cleanup context for later updates
  if (!cleanupCtx.unsubOrderRef) {
    cleanupCtx.unsubOrderRef = unsubOrderContainer;
  }

  return async () => {
    if (cleanupCalled) return;
    cleanupCalled = true;

    // Clear wave animation timer
    if (waveTimerRef) {
      clearInterval(waveTimerRef);
      waveTimerRef = null;
      panelState.waveFrame = undefined;
      panelState.waveColors = undefined;
    }

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
    
    // FIX (#10): Clear session circuit breaker to prevent unbounded map growth.
    const { clearSessionCircuitBreaker } = await import('../infrastructure/browser/browser-error-utils.ts');
    if (piSessionId) {
      clearSessionCircuitBreaker(piSessionId);
    }
    
    const activePanels = getPiActivePanels(piSessionId);
    if (activePanels.length === 0) {
      if (ctx.hasUI) {
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
 * Update the wave timer reference in the cleanup context
 */
export function updateWaveTimer(cleanupCtx: CleanupContext, timer: NodeJS.Timeout | null): void {
  (cleanupCtx as CleanupContext & { waveTimer?: NodeJS.Timeout | null }).waveTimer = timer;
}

/**
 * Update the unsubOrder reference in the cleanup context
 */
export function updateUnsubOrder(cleanupCtx: CleanupContext, unsub: (() => void) | null): void {
  if (cleanupCtx.unsubOrderRef) {
    cleanupCtx.unsubOrderRef.value = unsub;
  }
}

/**
 * Stop and clear wave animation
 */
export function stopWaveAnimation(panelState: ResearchPanelState): void {
  if (panelState.waveTimer) {
    clearInterval(panelState.waveTimer);
    panelState.waveTimer = null;
  }
  panelState.waveFrame = undefined;
  panelState.waveColors = undefined;
}