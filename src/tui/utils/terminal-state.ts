/**
 * Terminal State Helper
 *
 * Passive utilities for identifying terminal sequences.
 * 
 * ARCHITECTURAL NOTE:
 * This module should NEVER use process.stdin or process.stdout directly
 * to modify terminal state or drain buffers. In an extension environment,
 * we must trust the host (Pi) to manage the terminal.
 */

import { 
  parseKey
} from '@earendil-works/pi-tui';

/**
 * Reset terminal state.
 * 
 * NO-OP in extension mode to prevent interference with host terminal management.
 */
export async function resetTerminalState(_drain: boolean = false): Promise<void> {
  // We no longer poke the terminal directly. 
}

/**
 * Check if a string appears to be an escape sequence.
 */
export function isEscapeSequence(data: string): boolean {
  return !!(data && data.startsWith('\u001b'));
}

/**
 * Check if a string appears to be an interaction key (Arrow, Nav, etc.)
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
          // SS3
          i += 2;
        } else if (next === '_' || next === 'P' || next === '^') {
          // APC, DCS, PM
          i++;
          while (i < data.length) {
            if (data[i] === '\u001b' && i + 1 < data.length && data[i + 1] === '\\') { // ST
              i += 2;
              break;
            }
            i++;
          }
        } else {
          i++;
        }
      }
      sequences.push(data.substring(start, i));
    } else {
      sequences.push(data[i]!);
      i++;
    }
  }
  
  return sequences;
}

/**
 * Get terminal state info for debugging.
 */
export function getTerminalStateInfo() {
  return {
    columns: process.stdout?.columns,
    rows: process.stdout?.rows,
    env: {
      TERM: process.env['TERM'],
      TERM_PROGRAM: process.env['TERM_PROGRAM'],
    },
  };
}
