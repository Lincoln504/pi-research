/**
 * Extended Type Definitions for pi Extension Context
 *
 * These types extend the base ExtensionContext from @mariozechner/pi-coding-agent
 * to provide type safety for additional properties that are accessed at runtime.
 */

import type { SettingsManager } from '@mariozechner/pi-coding-agent';

/**
 * Session manager interface for accessing session metadata
 */
export interface SessionManager {
  getSessionId(): string;
  getSessionFile(): string;
}

/**
 * Extended ExtensionContext with additional properties
 * Note: We don't extend ExtensionContext to avoid type conflicts with
 * ReadonlySessionManager. This is used as a cast target only.
 */
export interface ExtendedExtensionContext {
  sessionManager?: SessionManager;
  settingsManager?: SettingsManager;
}

/**
 * Model with ID property and optional cost information
 */
export interface ModelWithId {
  id: string;
  cost?: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}

/**
 * Agent session event with usage and error information
 */
export interface ExtendedAgentSessionEvent {
  type: string;
  message?: {
    role?: string;
    usage?: {
      totalTokens?: number;
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
    };
  };
  isError?: boolean;
}
