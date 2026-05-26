/**
 * Central type definitions for pi-research
 * This module provides strongly-typed interfaces to replace 'as any' usage
 */

/**
 * Research depth levels
 */
export type ResearchDepth = 0 | 1 | 2 | 3;

/**
 * LLM response metadata including usage and stop reasons
 */
export interface LLMResponseMetadata {
  stopReason?: string;
  errorMessage?: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    cost?: {
      prompt?: number;
      completion?: number;
      total?: number;
    };
  };
}

/**
 * Research result details
 */
export interface ResearchResultDetails {
  totalTokens?: number;
  cost?: number;
  [key: string]: unknown;
}

/**
 * Browser task with query or URL
 */
export interface BrowserTask {
  query?: string;
  url?: string;
  [key: string]: unknown;
}

/**
 * Context object threaded through cleanup operations for a research session.
 */
export interface CleanupContext {
  researchId: string;
  piSessionId: string;
  masterWidgetId: string;
  panelState: import('./research-panel-types.ts').ResearchPanelState;
  waveTimer: NodeJS.Timeout | null;
  unsubOrder: (() => void) | null;
  unsubInput: (() => void) | null;
  unsubOrderRef?: { value: (() => void) | null };
  unsubInputRef?: { value: (() => void) | null };
}

/**
 * Research message from observer events
 */
export interface ResearchMessage {
  type: string;
  content?: string;
  [key: string]: unknown;
}

/**
 * Node.js error with code property
 */
export interface NodeError extends Error {
  code?: string;
  errno?: number;
  syscall?: string;
  [key: string]: unknown;
}

/**
 * Global state getter function
 */
export type GlobalStateGetter = () => Record<string, unknown>;

/**
 * Abort cleanup function
 */
export type AbortCleanup = () => void;

/**
 * Stored model from knowledge store
 */
export interface StoredModel {
  data?: Uint8Array;
  [key: string]: unknown;
}

/**
 * Configuration section types
 */
export type ConfigSection = 'health' | 'knowledge' | 'settings' | 'metrics';