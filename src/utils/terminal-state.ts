/**
 * Terminal State Helper
 *
 * Provides utilities for managing terminal state during reload/shutdown
 * to prevent ghost characters from leaking to the shell.
 */

/**
 * Reset terminal to a safe, known state.
 *
 * This disables:
 * - Kitty keyboard protocol (\x1b[<u)
 * - xterm modifyOtherKeys mode (\x1b[>4;0m)
 * - Bracketed paste mode (\x1b[?2004l)
 * - Mouse tracking (1000, 1002, 1003, 1006)
 * - Shows cursor (\x1b[?25h)
 *
 * @param drain - Whether to drain input after reset (default: true)
 */
export async function resetTerminalState(drain: boolean = true): Promise<void> {
  try {
    // Disable Kitty keyboard protocol
    process.stdout.write('\x1b[<u');

    // Disable xterm modifyOtherKeys mode
    process.stdout.write('\x1b[>4;0m');

    // Disable bracketed paste mode
    process.stdout.write('\x1b[?2004l');

    // Disable mouse tracking
    process.stdout.write('\x1b[?1000l');
    process.stdout.write('\x1b[?1002l');
    process.stdout.write('\x1b[?1003l');
    process.stdout.write('\x1b[?1006l');

    // Show cursor (in case it was hidden)
    process.stdout.write('\x1b[?25h');

    // Optional drain to consume any pending protocol responses
    if (drain && process.stdin.isTTY) {
      await drainTerminalInput(100, 20);
    }
  } catch (_error) {
    // Ignore errors - terminal might be in an invalid state
  }
}

/**
 * Check if a string appears to be an escape sequence.
 *
 * @param data - Input string to check
 * @returns true if the string starts with ESC (\u001b)
 */
export function isEscapeSequence(data: string): boolean {
  return data.startsWith('\u001b');
}

/**
 * Check if a string appears to be a Kitty keyboard protocol response.
 *
 * Kitty responses match: /^\u001b\[\?[\d;]+u$/
 * Examples: \u001b[?4;1;3u, \u001b[?0u, etc.
 *
 * @param data - Input string to check
 * @returns true if this looks like a Kitty protocol response
 */
export function isKittyProtocolResponse(data: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /^\u001b\[\?[\d;]+u$/.test(data);
}

/**
 * Check if a string appears to be a CSI (Control Sequence Introducer) sequence
 * or a DEC private-mode / application-keypad sequence.
 *
 * - Standard CSI:          ESC [  (cursor movement, colors, mode settings, etc.)
 * - Normal Keypad mode:    ESC >  (DEC)
 * - Alternate Keypad mode: ESC =  (DEC)
 *
 * @param data - Input string to check
 * @returns true if this looks like a CSI or DEC keypad escape sequence
 */
export function isCSISequence(data: string): boolean {
  return data.startsWith('\u001b[') || data.startsWith('\u001b>') || data.startsWith('\u001b=');
}

/**
 * Check if a string appears to be an OSC (Operating System Command) sequence.
 *
 * OSC sequences: ESC ] ... BEL (\x07) or ESC ] ... ST (\u001b\\)
 *
 * @param data - Input string to check
 * @returns true if this looks like an OSC sequence
 */
export function isOSCSequence(data: string): boolean {
  return (
    (data.startsWith('\u001b]') && data.includes('\x07')) ||
    data.endsWith('\u001b\\')
  );
}

/**
 * Check if a string appears to be an APC (Application Program Command) sequence.
 *
 * APC sequences: ESC _ ... ST
 *
 * @param data - Input string to check
 * @returns true if this looks like an APC sequence
 */
export function isAPCSequence(data: string): boolean {
  return data.startsWith('\u001b_') && data.endsWith('\u001b\\');
}

/**
 * Check if a string should be consumed to prevent terminal state leaks.
 *
 * Returns true for:
 * - Kitty protocol responses
 * - CSI sequences (cursor movement, colors, etc.)
 * - OSC sequences (window title, etc.)
 * - APC sequences (application-specific commands)
 * - Any other escape sequence
 *
 * @param data - Input string to check
 * @returns true if this should be consumed (not forwarded to shell)
 */
export function shouldConsumeForCleanup(data: string): boolean {
  if (!data) return false;

  // Empty or single character - only consume if it's ESC itself
  if (data.length === 1) {
    return data === '\u001b';
  }

  // Kitty protocol response
  if (isKittyProtocolResponse(data)) {
    return true;
  }

  // CSI sequence (most common terminal escape sequences)
  if (isCSISequence(data)) {
    return true;
  }

  // OSC sequence (window title, etc.)
  if (isOSCSequence(data)) {
    return true;
  }

  // APC sequence (application commands)
  if (isAPCSequence(data)) {
    return true;
  }

  // Any other escape sequence
  if (isEscapeSequence(data)) {
    return true;
  }

  return false;
}

/**
 * Drain terminal input buffer.
 *
 * This reads any pending input from stdin and discards it.
 * Useful for consuming late-arriving protocol responses.
 *
 * @param maxMs - Maximum time to wait for input (default: 100ms)
 * @param idleMs - Idle time before considering buffer drained (default: 20ms)
 * @returns Promise that resolves when buffer is drained or timeout
 */
export async function drainTerminalInput(
  maxMs: number = 100,
  idleMs: number = 20
): Promise<void> {
  const originalRaw = process.stdin.isRaw;
  let lastDataTime = Date.now();

  try {
    // Ensure stdin is readable
    if (!process.stdin.isRaw && process.stdin.setRawMode) {
      process.stdin.setRawMode(true);
    }

    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    const onData = () => {
      lastDataTime = Date.now();
    };

    process.stdin.on('data', onData);

    const endTime = Date.now() + maxMs;

    while (true) {
      const now = Date.now();
      const timeLeft = endTime - now;

      if (timeLeft <= 0) {
        break;
      }

      const timeSinceLastData = now - lastDataTime;
      if (timeSinceLastData >= idleMs) {
        break;
      }

      await new Promise((resolve) => {
        const waitTime = Math.min(idleMs, timeLeft);
        setTimeout(resolve, waitTime);
      });
    }

    process.stdin.removeListener('data', onData);
  } finally {
    // Restore original state
    if (!originalRaw && process.stdin.setRawMode) {
      process.stdin.setRawMode(originalRaw);
    }
    // Only pause if we're not in a TTY or if it was explicitly paused before.
    // In a persistent TUI like pi, we should generally leave stdin resumed.
    if (!process.stdin.isTTY) {
        process.stdin.pause();
    }
  }
}

/**
 * Create an enhanced terminal input handler that prevents escape sequence leaks.
 *
 * This wraps a standard input handler and ensures all escape sequences are
 * consumed before calling the underlying handler.
 *
 * @param baseHandler - The original input handler
 * @returns Enhanced input handler that consumes escape sequences
 */
export function createSafeInputHandler(
  baseHandler: (data: string) => { consume?: boolean; data?: string } | undefined
): (data: string) => { consume?: boolean; data?: string } | undefined {
  return (data: string) => {
    // Always consume escape sequences to prevent leaks
    if (shouldConsumeForCleanup(data)) {
      return { consume: true };
    }

    // Delegate to base handler for non-escape sequences
    return baseHandler(data);
  };
}

/**
 * Get terminal state info for debugging.
 *
 * @returns Object with terminal state information
 */
export function getTerminalStateInfo() {
  return {
    isRaw: process.stdin.isRaw,
    isTTY: process.stdin.isTTY,
    columns: process.stdout.columns,
    rows: process.stdout.rows,
    env: {
      TERM: process.env['TERM'],
      TERM_PROGRAM: process.env['TERM_PROGRAM'],
      TERM_PROGRAM_VERSION: process.env['TERM_PROGRAM_VERSION'],
      KITTY_WINDOW_ID: process.env['KITTY_WINDOW_ID'],
      WEZTERM_VERSION: process.env['WEZTERM_VERSION'],
      TMUX: process.env['TMUX'],
    },
  };
}