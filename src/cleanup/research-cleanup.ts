/**
 * Research Cleanup Module
 *
 * Handles cleanup operations for research sessions:
 * - Terminal input draining to prevent protocol response leaks
 * - Wave animation timer cleanup
 * - Session and panel cleanup
 * - Shared links cleanup
 */

import type { ExtensionContext } from '@mariozechner/pi-coding-agent';
import { logger } from '../logger.ts';
import {
  endResearchSession,
  getPiActivePanels,
  refreshAllSessions,
} from '../utils/session-state.ts';
import { cleanupSharedLinks } from '../utils/shared-links.ts';
import { resetTerminalState } from '../utils/terminal-state.ts';
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
    unsubInput,
  } = cleanupCtx;
  
  const { ctx } = deps;
  
  let cleanupCalled = false;
  let waveTimerRef = waveTimer;
  
  // Use reference objects to allow updating after creation
  const unsubOrderContainer = cleanupCtx.unsubOrderRef || { value: unsubOrder };
  const unsubInputContainer = cleanupCtx.unsubInputRef || { value: unsubInput };
  
  // Store reference objects in cleanup context for later updates
  if (!cleanupCtx.unsubOrderRef) {
    (cleanupCtx as any).unsubOrderRef = unsubOrderContainer;
  }
  if (!cleanupCtx.unsubInputRef) {
    (cleanupCtx as any).unsubInputRef = unsubInputContainer;
  }

  return async () => {
    if (cleanupCalled) return;
    cleanupCalled = true;

    // Drain terminal input to consume any pending protocol responses
    // This prevents Kitty protocol responses (like \x1b[?4;1;3u) from leaking to the shell
    try {
      const tuiUI = ctx.ui as { tui?: { terminal?: { drainInput?: (timeoutMs: number, maxAttempts: number) => Promise<void> } } };
      const tuiTerminal = tuiUI?.tui?.terminal;
      if (tuiTerminal && typeof tuiTerminal.drainInput === 'function') {
        // Use pi-tui's built-in drainInput if available
        await tuiTerminal.drainInput(100, 20);
      } else if (process.stdin.isTTY) {
        // Fallback: ensure terminal is in a safe state and drain input
        await resetTerminalState();
      }
    } catch (error) {
      logger.warn('[research] Failed to drain terminal input:', error);
    }

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
    
    if (unsubInputContainer.value) {
      unsubInputContainer.value();
      unsubInputContainer.value = null;
    }

    endResearchSession(piSessionId, researchId);
    cleanupSharedLinks(researchId);
    
    const activePanels = getPiActivePanels(piSessionId);
    if (activePanels.length === 0) {
      ctx.ui.setWidget(masterWidgetId, undefined);
      const tuiUI = ctx.ui as { setWorkingVisible?: (visible: boolean) => void };
      if (typeof tuiUI?.setWorkingVisible === 'function') {
        tuiUI.setWorkingVisible(true);
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
 * Update the unsubInput reference in the cleanup context
 */
export function updateUnsubInput(cleanupCtx: CleanupContext, unsub: (() => void) | null): void {
  if (cleanupCtx.unsubInputRef) {
    cleanupCtx.unsubInputRef.value = unsub;
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