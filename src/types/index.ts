/**
 * Central type definitions for pi-research
 * This module provides strongly-typed interfaces to replace 'as any' usage
 */

/**
 * Tool definition parameters
 */
export interface ToolParameters {
  [key: string]: unknown;
}

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
  usage?: LLMUsage;
}

/**
 * Token and cost usage information
 */
export interface LLMUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cost?: {
    prompt?: number;
    completion?: number;
    total?: number;
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
 * Extended research context with additional properties
 */
export interface ExtendedResearchContext {
  model?: {
    id: string;
    provider?: string;
    [key: string]: unknown;
  };
  ui?: {
    tui?: {
      terminal?: {
        [key: string]: unknown;
      };
    };
    setWorkingVisible?: (visible: boolean) => void;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Research state including wave animation timer
 */
export interface ResearchState {
  waveTimer?: NodeJS.Timeout | null;
  waveFrame?: number | undefined;
  waveColors?: string[] | undefined;
  needsClear?: boolean;
  browserServer?: {
    disconnect?: () => Promise<void>;
    [key: string]: unknown;
  };
  schedulerVersion?: string;
  gpuOwner?: {
    release?: () => Promise<void>;
    [key: string]: unknown;
  };
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
 * Browser scheduler interface
 */
export interface BrowserScheduler {
  runSearch: (query: string, config?: unknown) => Promise<unknown>;
  runScrape: (url: string, config?: unknown) => Promise<unknown>;
  [key: string]: unknown;
}

/**
 * Health registry check entry
 */
export interface HealthRegistryEntry {
  name: string;
  status: 'healthy' | 'unhealthy' | 'degraded';
  lastCheck?: Date;
  [key: string]: unknown;
}

/**
 * Cleanup context for research operations
 */
export interface CleanupContext {
  waveTimer?: NodeJS.Timeout;
  unsubOrder?: () => void;
  unsubInput?: () => void;
  [key: string]: unknown;
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
 * Research observer event
 */
export interface ResearchObserverEvent {
  message: ResearchMessage;
  [key: string]: unknown;
}

/**
 * Research action for evaluation decisions
 */
export interface ResearchAction {
  type: string;
  query?: string;
  url?: string;
  [key: string]: unknown;
}

/**
 * Document from scraper with toMarkdownAll method
 */
export interface ScrapedDocument {
  toMarkdownAll(): string;
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
 * Configuration item for settings
 */
export interface ConfigItem<T = unknown> {
  key: string;
  type: 'boolean' | 'string' | 'number' | 'select';
  value: T;
  options?: T[];
  description?: string;
  [key: string]: unknown;
}

/**
 * ONNX environment
 */
export interface ONNXEnvironment {
  onnx?: {
    wasm?: {
      paths?: {
        [key: string]: string;
      };
    };
  };
  [key: string]: unknown;
}

/**
 * Pipeline disposal interface
 */
export interface DisposablePipeline {
  dispose(): Promise<void>;
  [key: string]: unknown;
}

/**
 * Security databases configuration
 */
export interface SecurityDatabases {
  [key: string]: string[];
}

/**
 * Configuration section types
 */
export type ConfigSection = 'health' | 'errors' | 'knowledge' | 'settings' | 'metrics';