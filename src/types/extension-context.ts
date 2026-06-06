/**
 * Extended Type Definitions for pi Extension Context
 *
 * These types extend the base ExtensionContext from @earendil-works/pi-coding-agent
 * to provide type safety for additional properties that are accessed at runtime.
 */

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
export type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';

/**
 * Session manager interface for accessing session metadata
 */
export interface SessionManager {
  getSessionId(): string;
  getSessionFile(): string;
}

/**
 * Extended ExtensionContext with additional properties.
 * Provides type safety for properties accessed at runtime.
 */
export interface ExtendedExtensionContext extends ExtensionContext {
   /** Session ID (provided by extension host) */
   sessionId?: string;
   /** Model registry for API key resolution */
   modelRegistry: any;
   /** Settings manager (provided in some contexts) */
   settingsManager?: any;
   /** Current tool exclusion list */
   excludeTools?: string[];
   /** Abort the current agent operation */
   abort(): void;
   /** Gracefully shutdown pi and exit. Available in all contexts. */
   shutdown(): void;
   /** Get current context usage for the active model. */
   getContextUsage(): any;
   /** Trigger compaction without awaiting completion. */
   compact(options?: any): void;
   /** Get the current effective system prompt. */
   getSystemPrompt(): string;
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
 * Re-export AgentSessionEvent as ExtendedAgentSessionEvent for backwards compat.
 * The real SDK type has the correct shape for all event fields.
 */
export type { AgentSessionEvent as ExtendedAgentSessionEvent } from '@earendil-works/pi-coding-agent';
