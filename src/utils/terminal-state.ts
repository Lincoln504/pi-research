/**
 * Terminal State Helper
 *
 * Provides utilities for managing terminal state during reload/shutdown
 * to prevent ghost characters from leaking to the shell.
 */

import { 
  parseKey
} from '@earendil-works/pi-tui';

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
 * Check if a string appears to be a CSI (Control Sequence Introducer) response.
 *
 * We specifically target responses that should be consumed to prevent leaks:
 * - Device Attributes: ESC [ ? ... c
 * - Cursor Position:  ESC [ ... ; ... R
 * - Kitty Status:     ESC [ ? ... u
 *
 * @param data - Input string to check
 * @returns true if this looks like a CSI response that should be consumed
 */
export function isCSIResponse(data: string): boolean {
  if (!data.startsWith('\u001b[')) return false;

  // Kitty status response (starts with ?)
  if (data.startsWith('\u001b[?')) {
    return true;
  }

  // Cursor position report (matches \u001b[\d+;\d+R)
  if (/^\u001b\[\d+;\d+R$/.test(data)) {
    return true;
  }

  return false;
}

/**
 * Check if a string appears to be an interaction key (Arrow, Nav, etc.)
 *
 * @param data - Input string to check
 * @returns true if this looks like a user interaction key
 */
export function isInteractionKey(data: string): boolean {
  if (!data) return false;

  // 1. Try parsing as standard key sequence (handles most interaction keys)
  const parsed = parseKey(data);
  if (parsed) {
    return true;
  }

  // 2. Fallback for single characters or custom sequences
  if (data.length === 1) {
    const code = data.charCodeAt(0);
    // Printable ASCII or common control keys (Enter, Tab, etc.)
    return (code >= 32 && code <= 126) || code === 13 || code === 9 || code === 10 || code === 27 || code === 127;
  }

  return false;
}

/**
 * Split a string into individual terminal escape sequences and characters.
 *
 * @param data - Raw input string from terminal
 * @returns Array of individual sequences/characters
 */
export function splitTerminalSequences(data: string): string[] {
  if (!data) return [];
  
  const sequences: string[] = [];
  let i = 0;
  
  while (i < data.length) {
    if (data[i] === '\u001b') {
      const start = i;
      i++;
      
      if (i < data.length) {
        const next = data[i];
        if (next === '[') {
          // CSI (Control Sequence Introducer)
          i++;
          while (i < data.length) {
            const charCode = data.charCodeAt(i);
            // End of CSI is a character in 0x40-0x7E
            if (charCode >= 0x40 && charCode <= 0x7E) {
              i++;
              break;
            }
            i++;
          }
        } else if (next === ']') {
          // OSC (Operating System Command)
          i++;
          while (i < data.length) {
            if (data[i] === '\u0007') { // BEL
              i++;
              break;
            }
            if (data[i] === '\u001b' && i + 1 < data.length && data[i + 1] === '\\') { // ST
              i += 2;
              break;
            }
            i++;
          }
        } else if (next === 'O') {
          // SS3 (Single Shift Select 3) - common for nav keys
          i += 2;
        } else if (next === '_' || next === 'P' || next === '^') {
          // APC, DCS, PM - end with ST
          i++;
          while (i < data.length) {
            if (data[i] === '\u001b' && i + 1 < data.length && data[i + 1] === '\\') { // ST
              i += 2;
              break;
            }
            i++;
          }
        } else {
          // Simple 2-char escape sequence
          i++;
        }
      }
      sequences.push(data.substring(start, i));
    } else {
      // Single normal character
      sequences.push(data[i]!);
      i++;
    }
  }
  
  return sequences;
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
    (data.startsWith('\u001b]') && (data.includes('\x07') || data.includes('\u001b\\')))
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
 * Returns true for terminal-generated responses that might leak to the shell,
 * but returns false for user-initiated interaction keys.
 *
 * @param data - Input string to check
 * @returns true if this should be consumed (not forwarded to shell/TUI)
 */
export function shouldConsumeForCleanup(data: string): boolean {
  if (!data) return false;

  // Split input into individual sequences and check them
  // This prevents interleaved responses from swallowing keys.
  const parts = splitTerminalSequences(data);
  
  // If there's more than one part, we don't consume the whole thing.
  // Instead, we rely on createSafeInputHandler to filter them one-by-one.
  if (parts.length > 1) {
    return false;
  }

  const part = parts[0]!;

  // Never consume known interaction keys (Arrows, Nav keys, Kitty keys, Enter, etc.)
  if (isInteractionKey(part)) {
    return false;
  }

  // Consume known terminal responses
  if (isCSIResponse(part)) {
    return true;
  }

  // OSC sequence (window title, etc.)
  if (isOSCSequence(part)) {
    return true;
  }

  // APC sequence (application commands)
  if (isAPCSequence(part)) {
    return true;
  }

  // For any other escape sequence, we default to NOT consuming it if it 
  // doesn't match our known "safe to consume" response patterns.
  // This is a "safe by default" approach to avoid breaking TUIs.
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
 * This wraps a standard input handler and ensures all terminal-generated
 * escape sequences are consumed before calling the underlying handler.
 * It correctly handles batched/interleaved sequences.
 *
 * @param baseHandler - The original input handler
 * @returns Enhanced input handler that consumes terminal responses
 */
export function createSafeInputHandler(
  baseHandler: (data: string) => { consume?: boolean; data?: string } | undefined
): (data: string) => { consume?: boolean; data?: string } | undefined {
  return (data: string) => {
    const parts = splitTerminalSequences(data);
    const results: Array<{ consume?: boolean; data?: string } | undefined> = [];
    
    // Process each part individually
    for (const part of parts) {
      if (shouldConsumeForCleanup(part)) {
        results.push({ consume: true });
      } else {
        results.push(baseHandler(part));
      }
    }

    // If any part wants to consume, or if we have a mix, we need to decide.
    // In Pi CLI, onTerminalInput should return one result for the whole chunk.
    const allConsumed = results.every(r => r?.consume === true);
    if (allConsumed) {
      return { consume: true };
    }

    const someConsumed = results.some(r => r?.consume === true);
    if (someConsumed) {
      // Interleaved chunk. We only want to forward the non-consumed parts.
      const remainingData = parts
        .filter((_, i) => !results[i]?.consume)
        .join('');
      
      if (!remainingData) {
        return { consume: true };
      }

      // Return the filtered data string. 
      // This ensures interaction keys are preserved while protocol leak is blocked.
      return { consume: false, data: remainingData };
    }

    // Nothing was terminal-generated, pass through
    return undefined;
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
