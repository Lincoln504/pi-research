/**
 * Extended Type Definitions for pi Extension Context
 *
 * These types extend the base ExtensionContext from @earendil-works/pi-coding-agent
 * to provide type safety for additional properties that are accessed at runtime.
 */

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
export type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';

/**
 * Extended ExtensionContext with additional properties.
 * Provides type safety for properties accessed at runtime.
 *
 * NOTE: We do NOT re-declare properties from ExtensionContext (sessionManager,
 * modelRegistry, etc.) to avoid type conflicts when the base library evolves.
 * Instead, consumers cast to ExtendedExtensionContext only for the properties
 * that the base type doesn't include (sessionId, settingsManager, excludeTools).
 */
export interface ExtendedExtensionContext extends ExtensionContext {
   /** Session ID (provided by extension host) */
   sessionId?: string;
   /** Settings manager (provided in some contexts) */
   settingsManager?: any;
   /** Current tool exclusion list */
   excludeTools?: string[];
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


