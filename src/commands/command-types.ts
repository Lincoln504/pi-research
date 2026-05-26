/**
 * Command Types
 *
 * Shared types for command implementations.
 */

import type { ExtensionUIContext } from '@mariozechner/pi-coding-agent';

/**
 * Base command context with minimal UI support.
 */
export interface CommandContext {
  ui: {
    notify: (message: string, type: string) => void;
  };
  hasUI?: boolean;
  cwd?: string;
}

/**
 * Extended command context with full ExtensionUIContext support.
 */
export interface ExtendedCommandContext {
  ui: ExtensionUIContext;
  hasUI?: true;
  cwd?: string;
}