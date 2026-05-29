/**
 * PI Session Utilities
 *
 * Helper functions for working with PI sessions
 */

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { ExtendedExtensionContext } from '../types/extension-context.ts';

export interface PiSessionMetadata {
  piSessionId: string;
  sessionFile?: string;
  cwd?: string;
}

/**
 * Extract PI session metadata from ExtensionContext
 */
export function getPiSessionMetadata(ctx: ExtensionContext): PiSessionMetadata {
  const extendedCtx = ctx as ExtendedExtensionContext;
  const sessionManager = extendedCtx.sessionManager;
  
  const piSessionId = typeof sessionManager?.getSessionId === 'function' 
    ? String(sessionManager.getSessionId()) 
    : 'default';
  
  const sessionFile = typeof sessionManager?.getSessionFile === 'function' 
    ? String(sessionManager.getSessionFile()) 
    : undefined;

  return {
    piSessionId,
    sessionFile,
    cwd: ctx.cwd,
  };
}

/**
 * Get the current PI session ID from ExtensionContext
 */
export function getPiSessionId(ctx: ExtensionContext): string {
  const metadata = getPiSessionMetadata(ctx);
  return metadata.piSessionId;
}

/**
 * Get the session file path from ExtensionContext
 */
export function getSessionFile(ctx: ExtensionContext): string | undefined {
  const metadata = getPiSessionMetadata(ctx);
  return metadata.sessionFile;
}

/**
 * Check if we're running in a default session (not a named session)
 */
export function isDefaultSession(ctx: ExtensionContext): boolean {
  const metadata = getPiSessionMetadata(ctx);
  return metadata.piSessionId === 'default';
}