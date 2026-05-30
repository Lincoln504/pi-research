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
import { getActiveSessionCount } from '../utils/session-state.ts';
import { shouldConsumeForCleanup, createSafeInputHandler } from '../utils/terminal-state.ts';
import { logger } from '../logger.ts';

/**
 * Global state for TUI controller
 */
interface GlobalTuiState {
  /** Unsubscribe function for terminal input listener */
  unsubInput: (() => void) | null;
  /** Whether an interactive custom TUI is currently active */
  isInteractiveTuiActive: boolean;
}

const state: GlobalTuiState = {
  unsubInput: null,
  isInteractiveTuiActive: false,
};

/**
 * Initialize the global TUI controller
 * 
 * @param ui - The UI context from Pi
 */
export function initGlobalTuiController(ui: ExtensionUIContext): void {
  if (state.unsubInput) return;

  // Double check if ui and onTerminalInput exist (it should in interactive mode)
  if (!ui || typeof ui.onTerminalInput !== 'function') {
    logger.debug('[TUI] Global TUI controller skipped: UI context or onTerminalInput not available');
    return;
  }

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
        // Trigger abort for all sessions in this Pi session.
        logger.info(`[TUI] Global cancel requested (${data === '\x03' ? 'Ctrl+C' : 'Esc'}). Aborting active sessions...`);
        
        // We use dynamic import to avoid circular dependency
        import('../utils/session-state.ts').then(({ clearAllSessionState }) => {
           clearAllSessionState();
        });
      }
      
      // Let the key fall through so Pi can handle its own cancellation
      // or other TUIs can respond.
      return undefined;
    }

    // Consume only legitimate terminal status responses to prevent leaks.
    if (shouldConsumeForCleanup(data)) {
      return { consume: true };
    }

    return undefined;
  };

  // Register the global listener
  // We use the safe input handler to ensure interleaved data is handled correctly.
  state.unsubInput = ui.onTerminalInput(createSafeInputHandler(handleTerminalInput));
  
  logger.debug('[TUI] Global TUI controller initialized');
}

/**
 * Mark an interactive TUI as active/inactive
 */
export function setInteractiveTuiActive(active: boolean): void {
  state.isInteractiveTuiActive = active;
  logger.debug(`[TUI] Interactive TUI state changed: ${active}`);
}

/**
 * Dispose the global TUI controller
 */
export function disposeGlobalTuiController(): void {
  if (state.unsubInput) {
    state.unsubInput();
    state.unsubInput = null;
  }
}
