/**
 * Central type definitions for pi-research
 * This module provides strongly-typed interfaces to replace 'as any' usage
 */

/**
 * Research depth levels
 */
export type ResearchDepth = 0 | 1 | 2 | 3;

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
  sessionId?: string;
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
  unsubOrderRef?: { value: (() => void) | null };
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

