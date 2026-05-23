/**
 * Research TUI Manager
 *
 * Manages TUI interactions for research sessions:
 * - Master widget creation and updates
 * - Session panel management
 * - Terminal input handling for cancellation
 * - Debounced refresh coordination
 */

import type { ExtensionContext } from '@mariozechner/pi-coding-agent';
import {
  createMasterResearchPanel,
  createInitialPanelState,
} from './research-panel.ts';
import {
  registerSessionPanel,
  registerMasterUpdate,
  refreshAllSessions,
  onSessionOrderChange,
  abortAllSessions,
} from '../utils/session-state.ts';
import { shouldConsumeForCleanup } from '../utils/terminal-state.ts';
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
  unsubInput: (() => void) | null;
  debouncedRefresh: () => void;
  initializePanel: () => void;
  handleTerminalInput: (data: string) => { consume?: boolean } | undefined;
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
    piSessionId,
    researchId,
    query,
    modelId,
  } = tuiCtx;
  
  const { ctx } = deps;
  
  const masterWidgetId = `pi-research-master-${piSessionId}`;
  const panelState = createInitialPanelState(researchId, query, modelId);
  
  let unsubOrder: (() => void) | null = null;
  let unsubInput: (() => void) | null = null;
  let refreshTimeout: NodeJS.Timeout | null = null;
  let refreshScheduled = false;

  // Register the panel state
  registerSessionPanel(piSessionId, researchId, panelState);

  /**
   * Debounced refresh to avoid excessive UI updates
   */
  const debouncedRefresh = () => {
    if (refreshScheduled) return;
    refreshScheduled = true;
    
    refreshTimeout = setTimeout(() => {
      refreshScheduled = false;
      refreshAllSessions(piSessionId);
    }, 50); // 50ms debounce
  };

  /**
   * Initialize the master widget
   */
  const initializePanel = () => {
    const masterPanelCreator = createMasterResearchPanel(piSessionId, () => {
      // Get active panels lazily to avoid circular dependencies
      return getActivePanelsForSession(piSessionId);
    });
    
    ctx.ui.setWidget(masterWidgetId, (_tui: any, theme: any) => masterPanelCreator(_tui, theme), { placement: 'aboveEditor' });
  };

  /**
   * Handle terminal input for cancellation and cleanup
   */
  const handleTerminalInput = (data: string) => {
    // Check for specific cancel keys (Escape and Ctrl+C)
    if (data === '\x1b' || data === '\x03') {
      abortAllSessions(piSessionId);
      return { consume: true };
    }

    // Consume all escape sequences to prevent terminal state leaks
    // This includes Kitty protocol responses, CSI sequences, OSC sequences, etc.
    // Without this, late-arriving protocol responses leak to the shell after tool exit.
    if (shouldConsumeForCleanup(data)) {
      return { consume: true };
    }

    return undefined;
  };

  // Register master update function
  registerMasterUpdate(piSessionId, () => {
    debouncedRefresh();
    ctx.ui.setWidget(masterWidgetId, (_tui: any, theme: any) => {
      const masterPanelCreator = createMasterResearchPanel(piSessionId, () => {
        return getActivePanelsForSession(piSessionId);
      });
      return masterPanelCreator(_tui, theme);
    }, { placement: 'aboveEditor' });
  });

  // Subscribe to session order changes
  unsubOrder = onSessionOrderChange(piSessionId, () => refreshAllSessions(piSessionId));

  // Subscribe to terminal input
  unsubInput = ctx.ui.onTerminalInput(handleTerminalInput);

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
    
    if (unsubInput) {
      unsubInput();
      unsubInput = null;
    }
  };

  return {
    panelState,
    masterWidgetId,
    unsubOrder,
    unsubInput,
    debouncedRefresh,
    initializePanel,
    handleTerminalInput,
    dispose,
  };
}

/**
 * Get active panels for a session
 * Helper function to avoid circular dependencies
 */
function getActivePanelsForSession(piSessionId: string) {
  // Import at runtime to avoid circular dependencies
  const { getPiActivePanels } = require('../utils/session-state.ts');
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