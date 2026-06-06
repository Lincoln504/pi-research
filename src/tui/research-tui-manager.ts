/**
 * Research TUI Manager
 *
 * Manages TUI interactions for research sessions:
 * - Master widget creation and updates
 * - Session panel management
 * - Terminal input handling for cancellation
 * - Debounced refresh coordination
 */

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { TUI } from '@earendil-works/pi-tui';
import { logger } from '../logger.ts';
import type { Theme } from '../types/research-panel-types.ts';
import {
  createMasterResearchPanel,
  createInitialPanelState,
} from './research-panel.ts';
import {
  registerSessionPanel,
  registerMasterUpdate,
  refreshAllSessions,
  onSessionOrderChange,
  getPiActivePanels,
  normalizeSessionId,
} from '../utils/session-state.ts';
import { initGlobalTuiController } from './tui-controller.ts';
import type { ResearchPanelState } from './research-panel.ts';

export interface TuiContext {
  piSessionId: string;
  researchId: string;
  query: string;
  modelId: string;
}

export interface TuiDependencies {
  ctx: ExtensionContext;
}

export interface TuiManager {
  panelState: ResearchPanelState;
  masterWidgetId: string;
  unsubOrder: (() => void) | null;
  debouncedRefresh: () => void;
  initializePanel: () => void;
  dispose: () => void;
}

/**
 * Create a TUI manager for a research session
 */
export function createResearchTuiManager(
  tuiCtx: TuiContext,
  deps: TuiDependencies
): TuiManager {
  const {
    piSessionId: rawPiSessionId,
    researchId,
    query,
    modelId,
  } = tuiCtx;
  
  const piSessionId = normalizeSessionId(rawPiSessionId);
  const { ctx } = deps;
  
  const masterWidgetId = `pi-research-master-${piSessionId}`;
  const panelState = createInitialPanelState(piSessionId, researchId, query, modelId);
  logger.debug(`[tui-manager] Creating manager for session ${piSessionId}, research ${researchId}`);
  
  // Ensure the global TUI controller is initialized (handles cancellation and protocol leaks)
  // Only in TUI mode with UI available
  if (ctx.mode === 'tui' && ctx.hasUI) {
    initGlobalTuiController(ctx.ui);
  }

  let unsubOrder: (() => void) | null = null;
  let refreshTimeout: NodeJS.Timeout | null = null;
  let refreshScheduled = false;

  // Register the panel state
  registerSessionPanel(piSessionId, researchId, panelState);

  /**
   * Debounced refresh to avoid excessive UI updates
   */
  const debouncedRefresh = () => {
    // Only refresh if in TUI mode
    if (ctx.mode !== 'tui') return;

    if (refreshScheduled) return;
    refreshScheduled = true;
    
    refreshTimeout = setTimeout(() => {
      refreshScheduled = false;
      refreshAllSessions(piSessionId);
    }, 16); // 16ms debounce — must stay below wave timer interval (33ms) to not eat frames
  };

  /**
   * Initialize the master widget
   */
  const initializePanel = () => {
    // Only initialize if in TUI mode and UI is available
    if (ctx.mode !== 'tui' || !ctx.hasUI) return;

    const masterPanelCreator = createMasterResearchPanel(piSessionId, () => {
      // Get active panels lazily to avoid circular dependencies
      return getActivePanelsForSession(piSessionId);
    });
    
    ctx.ui.setWidget(masterWidgetId, (tui: TUI, theme: Theme) => masterPanelCreator(tui, theme), { placement: 'aboveEditor' });
  };

  // Register master update function (re-registers the widget to trigger a render)
  // setExtensionWidget() removes the old widget before adding the new one — no stacking.
  // Calling refreshAllSessions() here would cause an infinite loop:
  //   debouncedRefresh → refreshAllSessions → masterUpdate → refreshAllSessions → …
  registerMasterUpdate(piSessionId, () => {
    // Only update if in TUI mode and UI is available
    if (ctx.mode !== 'tui' || !ctx.hasUI) return;

    const masterPanelCreator = createMasterResearchPanel(piSessionId, () => {
      return getActivePanelsForSession(piSessionId);
    });
    ctx.ui.setWidget(masterWidgetId, (tui: TUI, theme: Theme) => masterPanelCreator(tui, theme), { placement: 'aboveEditor' });
  });

  // Subscribe to session order changes
  unsubOrder = onSessionOrderChange(piSessionId, () => refreshAllSessions(piSessionId));

  /**
   * Dispose of TUI resources
   */
  const dispose = () => {
    if (refreshTimeout) {
      clearTimeout(refreshTimeout);
      refreshTimeout = null;
    }
    
    if (unsubOrder) {
      unsubOrder();
      unsubOrder = null;
    }
  };

  return {
    panelState,
    masterWidgetId,
    unsubOrder,
    debouncedRefresh,
    initializePanel,
    dispose,
  };
}

/**
 * Get active panels for a session
 * Helper function to avoid circular dependencies
 */
function getActivePanelsForSession(piSessionId: string) {
  return getPiActivePanels(piSessionId);
}

/**
 * Hide the working indicator during research
 */
export function hideWorkingIndicator(ctx: ExtensionContext): void {
  const tuiUI = ctx.ui as { setWorkingVisible?: (visible: boolean) => void };
  if (typeof tuiUI?.setWorkingVisible === 'function') {
    tuiUI.setWorkingVisible(false);
  }
}

/**
 * Show the working indicator (typically on cleanup)
 */
export function showWorkingIndicator(ctx: ExtensionContext): void {
  const tuiUI = ctx.ui as { setWorkingVisible?: (visible: boolean) => void };
  if (typeof tuiUI?.setWorkingVisible === 'function') {
    tuiUI.setWorkingVisible(true);
  }
}