/**
 * Knowledge Store Service Interfaces
 */

import type { IService } from '../service-registry.ts';

/**
 * Single document record in the knowledge store
 */
export interface StoreDocument {
  url: string;
  text: string;
  content?: string;
  metadata: Record<string, any>;
  timestamp: number;
  workspace?: string;
  is_global?: boolean;
  ingestion_type?: string;
}

/**
 * ONNX runtime environment
 */
export interface ONNXRuntimeEnv {
  logLevel?: 'verbose' | 'info' | 'warning' | 'error' | 'fatal';
  debug?: boolean;
}

/**
 * HuggingFace environment with ONNX support (Transformers.js v4)
 */
export interface HFEnv {
  cacheDir: string;
  backends: {
    onnx: ONNXRuntimeEnv;
  };
}

/**
 * Disposable pipeline interface
 */
export interface DisposablePipeline {
  dispose(): Promise<void>;
}

/**
 * Embedder configuration options
 */
export interface EmbedderOptions {
  model: string;
  pooling?: 'mean' | 'cls' | 'last_token';
  queryPrefix?: string;
  initializationTimeoutMs?: number;
  device?: string;
  maxTokens?: number;
  batchSize?: number;
  charsPerToken?: number;
  documentPrefix?: string;
  stateManager?: any; // To avoid circular dependency with IStateManager
  useCache?: boolean;
}

/**
 * Embedder state
 */
export type EmbedderState = 'idle' | 'initializing' | 'ready' | 'failed' | 'disposing';

/**
 * Item to be ingested into the knowledge store
 */
export interface IngestionItem {
  url: string;
  markdown: string;
  content?: string;
  metadata?: Record<string, any>;
}

/**
 * A URL entry returned from the knowledge store with its description
 */
export interface StoreUrlEntry {
  url: string;
  description: string;
  provenance?: string;
}

/**
 * Embedder interface for text embedding operations
 */
export interface IEmbedder {
  getDevice(): string | null;
  getOriginalDevice(): string | null;
  getDimension(): number | null;
  isInitialized(): boolean;
  embed(text: string): Promise<Float32Array | number[]>;
  embedMany(texts: string[]): Promise<(Float32Array | number[])[]>;
  dispose(): Promise<void>;
}

/**
 * Core Knowledge Store interface for raw storage operations.
 */
export interface IKnowledgeStore extends IService {
  open(): Promise<void>;
  close(): Promise<void>;
  clear(filter?: string): Promise<void>;
  rebuildFtsIndex(): Promise<void>;
  count(): Promise<number>;
  search(query: string, options?: { limit?: number }): Promise<StoreDocument[]>;
  findRelevantUrls(query: string, options?: { limit?: number }): Promise<StoreUrlEntry[]>;
  rebuildDocument(url: string): Promise<{ text: string; description: string | null; metadata: Record<string, any> } | null>;
  findDocumentsByUrl(url: string): Promise<StoreDocument[]>;
  findByUrl(url: string): Promise<StoreDocument[]>;
  countScoped(workspace?: string): Promise<{ local: number; global: number; projects: number }>;
  
  /** Extended operations */
  addDocuments(docs: StoreDocument[]): Promise<void>;
  deleteByUrl(url: string): Promise<void>;
  deleteByUrlAndType(url: string, ingestionType: string): Promise<void>;
  isStoreClosed?(): boolean;

  /**
   * Export the knowledge store entries (summaries and vectors) for use in a web application.
   * @param outputPath - Path to save the exported JSON file
   */
  exportForWeb(outputPath: string): Promise<void>;
}

/**
 * Higher-level service interface for Knowledge Store management.
 */
export interface IKnowledgeStoreService extends IService {
  isReady(): boolean;
  getDevice(): string | null;
  getStore(): Promise<IKnowledgeStore | null>;
  getEmbedder(): Promise<IEmbedder | null>;
  getWriterQueue(): Promise<IWriterQueue | null>;
  clear(): Promise<void>;
  clearLocal(): Promise<void>;
  clearGlobal(): Promise<void>;
  
  /**
   * Export the knowledge store for web use.
   * @param outputPath - Path to save the exported JSON file
   */
  exportForWeb(outputPath: string): Promise<void>;
}

/**
 * Writer queue interface for batching write operations
 */
export interface IWriterQueue extends IService {
  drain(): Promise<void>;
  enqueue(item: IngestionItem): void;
}

/**
 * Metrics snapshot interface
 */
export interface IMetricsSnapshot {
  counters: Record<string, number>;
  gauges: Record<string, number>;
  histograms: Record<string, IMetricHistogram>;
}

/**
 * Metric histogram statistics interface
 */
export interface IMetricHistogram {
  count: number;
  min: number;
  max: number;
  avg: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
}
