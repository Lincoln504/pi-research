/**
 * Global TUI Controller
 *
 * Centralizes TUI-related logic that needs to be global across the extension:
 * - Single onTerminalInput listener per Pi session
 * - Protocol response filtering
 * - Global cancellation (Esc/Ctrl+C) with context awareness
 */

import type { ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import { matchesKey } from '@earendil-works/pi-tui';
import { getActiveSessionCount, abortAllSessions, refreshAllSessions } from '../utils/session-state.ts';
import { logger } from '../logger.ts';

/**
 * Global state for TUI controller
 */
interface GlobalTuiState {
  /** Unsubscribe function for terminal input listener */
  unsubInput: (() => void) | null;
  /** Whether an interactive custom TUI is currently active */
  isInteractiveTuiActive: boolean;
  /** The Pi session ID this controller belongs to */
  piSessionId: string | undefined;
}

const state: GlobalTuiState = {
  unsubInput: null,
  isInteractiveTuiActive: false,
  piSessionId: undefined,
};

/**
 * Initialize the global TUI controller
 * 
 * @param ui - The UI context from Pi
 * @param piSessionId - The current Pi session ID for scoped cancellation
 */
export function initGlobalTuiController(ui: ExtensionUIContext, piSessionId?: string): void {
  if (state.unsubInput) return;

  // Double check if ui and onTerminalInput exist (it should in interactive mode)
  if (!ui || typeof ui.onTerminalInput !== 'function') {
    logger.debug('[TUI] Global TUI controller skipped: UI context or onTerminalInput not available');
    return;
  }

  // Store the Pi session ID for scoped cancellation
  state.piSessionId = piSessionId;

  /**
   * Handle terminal input for cancellation and protocol cleanup

   */
  const handleTerminalInput = (data: string) => {
    // If an interactive TUI is active (like the config menu), 
    // let it handle ALL input. We don't want to trigger a global abort
    // while the user is navigating a menu.
    if (state.isInteractiveTuiActive) {
      return undefined;
    }

    // Check for specific global cancel keys (Escape and Ctrl+C)
    // We only trigger abort if research is actually running.
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
      const activeCount = getActiveSessionCount();
      if (activeCount > 0) {
        // FIX (New Issues B & E): Use abortAllSessions scoped to the current Pi session
        // instead of clearAllSessionState() which nukes ALL sessions across ALL Pi instances.
        logger.info(`[TUI] Global cancel requested (${data === '\x03' ? 'Ctrl+C' : 'Esc'}). Aborting active sessions...`);
        
        try {
          // Scope to this Pi session to avoid cross-session interference
          abortAllSessions(state.piSessionId);
        } catch (err) {
          logger.error('[TUI] Failed to abort sessions on cancel:', err);
        }
      }
      
      // Let the key fall through so Pi can handle its own cancellation
      // or other TUIs can respond.
      return undefined;
    }

    return undefined;
  };

  // Register the global listener
  state.unsubInput = ui.onTerminalInput(handleTerminalInput);
  
  logger.debug('[TUI] Global TUI controller initialized');
}

/**
 * Mark an interactive TUI as active/inactive
 */
export function setInteractiveTuiActive(active: boolean): void {
  state.isInteractiveTuiActive = active;
  logger.debug(`[TUI] Interactive TUI state changed: ${active}`);
  
  if (!active && state.piSessionId !== undefined) {
    // When the menu closes, immediately refresh the background research widgets
    // because they were paused while the menu was open to prevent TUI fighting.
    refreshAllSessions(state.piSessionId);
  }
}

/**
 * Check if an interactive TUI is active
 */
export function isInteractiveTuiActive(): boolean {
  return state.isInteractiveTuiActive;
}

/**
 * Dispose the global TUI controller
 */
export function disposeGlobalTuiController(): void {
  if (state.unsubInput) {
    state.unsubInput();
    state.unsubInput = null;
  }
  state.piSessionId = undefined;
  state.isInteractiveTuiActive = false;
}
