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
import type { ResearchPanelState } from '../tui/research-panel.ts';

export interface CleanupContext {
  researchId: string;
  piSessionId: string;
  masterWidgetId: string;
  panelState: ResearchPanelState;
  waveTimer: NodeJS.Timeout | null;
  unsubOrder: (() => void) | null;
  unsubInput: (() => void) | null;
}

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
  let unsubOrderRef = unsubOrder;
  let unsubInputRef = unsubInput;

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

    if (unsubOrderRef) {
      unsubOrderRef();
      unsubOrderRef = null;
    }
    
    if (unsubInputRef) {
      unsubInputRef();
      unsubInputRef = null;
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
  (cleanupCtx as CleanupContext & { unsubOrder?: (() => void) | null }).unsubOrder = unsub;
}

/**
 * Update the unsubInput reference in the cleanup context
 */
export function updateUnsubInput(cleanupCtx: CleanupContext, unsub: (() => void) | null): void {
  (cleanupCtx as CleanupContext & { unsubInput?: (() => void) | null }).unsubInput = unsub;
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