/**
 * Knowledge Store Service Interfaces
 */

import type { IService } from '../service-registry.ts';

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
 * Knowledge store interface for raw storage operations (the inner LanceDB store).
 */
export interface IKnowledgeStore extends IService {
  open(): Promise<void>;
  close(): Promise<void>;
  clear(): Promise<void>;
  rebuildFtsIndex(): Promise<void>;
  count(): Promise<number>;
  search(query: string, options?: { limit?: number }): Promise<any[]>;
  findRelevantUrls(query: string, options?: { limit?: number }): Promise<StoreUrlEntry[]>;
  rebuildDocument(url: string): Promise<{ text: string; description: string | null; metadata: Record<string, any> } | null>;
  findDocumentsByUrl(url: string): Promise<any[]>;
  /**
   * Export the knowledge store entries (summaries and vectors) for use in a web application.
   * @param outputPath - Path to save the exported JSON file
   */
  exportForWeb(outputPath: string): Promise<void>;
}

/**
 * Service-level interface for the knowledge store service wrapper.
 * This is the type for the object registered in the service registry under
 * ServiceNames.KNOWLEDGE_STORE. It manages the embedder, store, and writer
 * queue lifecycle, and provides access to the inner IKnowledgeStore.
 */
export interface IKnowledgeStoreService extends IService {
  isReady(): boolean;
  getDevice(): string | null;
  getStore(): Promise<IKnowledgeStore>;
  getEmbedder(): Promise<IEmbedder>;
  clear(): Promise<void>;
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