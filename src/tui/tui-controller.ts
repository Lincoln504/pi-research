/**
 * Global TUI Controller
 *
 * Centralizes TUI-related logic that needs to be global across the extension:
 * - Single onTerminalInput listener per Pi session
 * - Protocol response filtering
 * - Global cancellation (Esc/Ctrl+C) with context awareness
 */

import type { ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import { isKeyRelease, matchesKey } from '@earendil-works/pi-tui';
import { getActiveSessionCount, abortAllSessions, refreshAllSessions, hideMasterWidget } from '../orchestration/session-state.ts';
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
  // Always refresh the active session id FIRST — even when the input handler is
  // already wired from a prior run. A second research run in the same process must
  // scope cancellation (Esc/Ctrl+C), widget hide/restore, and abortAllSessions to
  // ITS session; the old guard returned early and left piSessionId stuck on run 1.
  state.piSessionId = piSessionId;

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
    // Key-RELEASE events must be ignored. Pi runs the Kitty keyboard protocol
    // with flag 2 (report event types), so every physical key sends TWO
    // sequences: the press, then a release ~100-200ms later
    // (e.g. ctrl+c press \x1b[99;5u, release \x1b[99;5:3u). Tui.handleTerminalInput
    // filters releases — but ONLY for the focused component, AFTER extension
    // input listeners run, and matchesKey cannot tell them apart
    // (matchesKittySequence parses codepoint+modifier but never the event type,
    // so a RELEASE matches matchesKey(data, 'ctrl+c') just like a press).
    // Observed live 2026-09-03: one physical Ctrl+C with text in the editor
    // logged "with editor text — clearing only" and then, 150ms later, the
    // RELEASE event matched ctrl+c, saw the editor pi had just cleared, and
    // aborted the research run. The same double-fire misclassified old
    // ctrl+c releases as "Esc" aborts in the logs. pi's own components never
    // see releases (tui filters them), so dropping them here matches pi's
    // semantics exactly. Key REPEATS (\x1b[99;5:2u) are genuine held-key intent
    // and keep flowing, like they do to pi's own components.
    if (isKeyRelease(data)) {
      return undefined;
    }

    // If an interactive TUI is active (like the config menu), 
    // let it handle ALL input. We don't want to trigger a global abort
    // while the user is navigating a menu.
    if (state.isInteractiveTuiActive) {
      return undefined;
    }

    // Check for specific global cancel keys (Escape and Ctrl+C)
    // We only trigger abort if research is actually running.
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
      if (matchesKey(data, 'ctrl+c')) {
        // Ctrl+C is pi's app.clear ("Clear editor"), NOT its cancel key — Esc is
        // app.interrupt. But pi's handleCtrlC() is TIME-based, not content-based:
        // first press clears the editor and arms a window, and a SECOND press
        // within 500ms calls shutdown() — exiting the entire pi process. There is
        // no "abort research" step anywhere in it. Extension input listeners run
        // BEFORE the focused editor and may consume keys, so this handler fully
        // owns the Ctrl+C policy while a run is active:
        //
        //   editor has text  → fall through: pi clears the text, run continues
        //                      (a follow-up press sees an empty editor → abort
        //                      branch below — the two-step cancel the user asked
        //                      for: clear first, second press aborts the run)
        //   editor empty AND → abort the run AND CONSUME the key. Consuming is
        //   run active         the fix: without it the abort fell through to pi's
        //                      handleCtrlC, and a double-press within 500ms (the
        //                      natural way to "abort now") shut down pi itself.
        //   editor empty AND → fall through untouched: pi's native behavior
        //   no run active      (clear/arm, double-press exit) must keep working.
        let editorText = '';
        try {
          editorText = typeof ui.getEditorText === 'function' ? (ui.getEditorText() ?? '') : '';
        } catch { /* editor gone mid-run — treat as empty (cancel) */ }
        if (editorText.length > 0) {
          logger.debug('[TUI] Ctrl+C with editor text — clearing only, research keeps running.');
          return undefined;
        }
        const activeCount = getActiveSessionCount();
        if (activeCount > 0) {
          logger.info('[TUI] Ctrl+C with empty editor — aborting active research (key consumed so pi\'s double-press exit cannot fire).');
          try {
            // Scope to this Pi session to avoid cross-session interference
            abortAllSessions(state.piSessionId);
          } catch (err) {
            logger.error('[TUI] Failed to abort sessions on Ctrl+C:', err);
          }
          return { consume: true };
        }
        // No research running — native pi Ctrl+C (clear editor / double-press exit).
        return undefined;
      }

      // Esc (pi's app.interrupt): panic-cancel regardless of editor text. Abort the
      // active run, then let the key fall through so Pi can also respond
      // (cancelling its own agent loop) and other TUIs can react.
      const activeCount = getActiveSessionCount();
      if (activeCount > 0) {
        logger.info('[TUI] Global cancel requested (Esc). Aborting active sessions...');
        try {
          // Scope to this Pi session to avoid cross-session interference
          abortAllSessions(state.piSessionId);
        } catch (err) {
          logger.error('[TUI] Failed to abort sessions on cancel:', err);
        }
      }
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

  if (active && state.piSessionId !== undefined) {
    // When a foreground menu opens, fully remove the live research panel from
    // the screen. Freezing its updates (the isInteractiveTuiActive gate) is not
    // enough: a tall, still-present panel above the editor crowds the inline
    // menu and leaves ghost rows behind. Removing it gives the menu the full
    // screen, identical to opening the menu with no run active.
    hideMasterWidget(state.piSessionId);
  }

  if (!active && state.piSessionId !== undefined) {
    // When the menu closes, immediately refresh the background research widgets
    // because they were paused/removed while the menu was open.
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
