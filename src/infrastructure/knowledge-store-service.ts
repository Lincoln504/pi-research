/**
 * Knowledge Store Service
 *
 * Service wrapper for the knowledge store functionality.
 * Provides clean interface for embedding and storage operations.
 */

import type { IService } from '../core/service-registry.ts';
import { ServiceLifecycle } from '../core/service-registry.ts';
import { logger } from '../logger.ts';
import type { IEmbedder, IKnowledgeStore, IWriterQueue } from '../core/service-interfaces.ts';

// Static imports from knowledge module
import {
  createKnowledgeStoreComponents,
  clearKnowledgeStore as clearKnowledgeStoreInternal,
  SUPPORTED_MODELS,
  getModelEmbedderConfig as getKnowledgeModelEmbedderConfig,
  getModelChunkConfig as getKnowledgeModelChunkConfig,
} from '../knowledge/index.ts';

/**
 * Knowledge Store Service Implementation
 */
export class KnowledgeStoreService implements IService {
  readonly name = 'knowledge-store';
  lifecycle = ServiceLifecycle.UNINITIALIZED;

  // Knowledge store components
  private _embedder: IEmbedder | null = null;
  private _store: IKnowledgeStore | null = null;
  private _writerQueue: IWriterQueue | null = null;

  // Initialization promise to prevent concurrent initialization
  private _initializationPromise: Promise<void> | null = null;

  async initialize(): Promise<void> {
    if (this.lifecycle === ServiceLifecycle.INITIALIZED) {
      return;
    }

    // Return existing initialization promise if in progress
    if (this._initializationPromise) {
      return this._initializationPromise;
    }

    this.lifecycle = ServiceLifecycle.INITIALIZING;
    logger.debug('[KnowledgeStoreService] Initializing...');

    this._initializationPromise = (async () => {
      try {
        // Create the knowledge store components
        const components = await createKnowledgeStoreComponents();

        this._embedder = components.embedder;
        this._store = components.store;
        this._writerQueue = components.writerQueue;

        const originalDevice = this._embedder?.getOriginalDevice() ?? '(unknown)';
        const actualDevice = this._embedder?.isInitialized() ? (this._embedder.getDevice() ?? '(deferred)') : '(deferred)';
        
        logger.debug(`[KnowledgeStoreService] Initialized. Device: ${actualDevice} (original: ${originalDevice})`);

        this.lifecycle = ServiceLifecycle.INITIALIZED;
      } catch (err) {
        logger.error('[KnowledgeStoreService] Initialization failed:', err);
        this.lifecycle = ServiceLifecycle.UNINITIALIZED;
        throw err;
      } finally {
        this._initializationPromise = null;
      }
    })();

    return this._initializationPromise;
  }

  async dispose(): Promise<void> {
    if (this.lifecycle === ServiceLifecycle.DISPOSED || this.lifecycle === ServiceLifecycle.UNINITIALIZED) {
      return;
    }

    this.lifecycle = ServiceLifecycle.DISPOSING;
    logger.debug('[KnowledgeStoreService] Disposing...');

    try {
      if (this._writerQueue) {
        await this._writerQueue.dispose?.();
      }
      
      if (this._store) {
        await this._store.close();
      }

      if (this._embedder) {
        await this._embedder.dispose?.();
      }

      this._embedder = null;
      this._store = null;
      this._writerQueue = null;

      logger.debug('[KnowledgeStoreService] Disposed');
    } catch (err) {
      logger.error('[KnowledgeStoreService] Error during disposal:', err);
    } finally {
      this.lifecycle = ServiceLifecycle.DISPOSED;
    }
  }

  /**
   * Check if the knowledge store is ready
   */
  isReady(): boolean {
    return this._embedder !== null && this._store !== null && this._writerQueue !== null;
  }

  /**
   * Check if the embedder is initialized
   */
  isEmbedderInitialized(): boolean {
    return this._embedder !== null && this._embedder.isInitialized();
  }

  /**
   * Get the embedder instance
   */
  async getEmbedder(): Promise<IEmbedder> {
    await this.initialize();
    if (!this._embedder) {
      throw new Error('[KnowledgeStoreService] Embedder not initialized');
    }
    return this._embedder;
  }

  /**
   * Get the knowledge store instance
   */
  async getStore(): Promise<IKnowledgeStore> {
    await this.initialize();
    if (!this._store) {
      throw new Error('[KnowledgeStoreService] Store not initialized');
    }
    return this._store;
  }

  /**
   * Get the writer queue instance
   */
  async getWriterQueue(): Promise<IWriterQueue> {
    await this.initialize();
    if (!this._writerQueue) {
      throw new Error('[KnowledgeStoreService] Writer queue not initialized');
    }
    return this._writerQueue;
  }

  /**
   * Get the embedder device
   */
  getDevice(): string | null {
    return this._embedder?.getDevice() ?? null;
  }

  /**
   * Get the original device preference
   */
  getOriginalDevice(): string | null {
    return this._embedder?.getOriginalDevice() ?? null;
  }

  /**
   * Embed a text string
   */
  async embed(text: string): Promise<number[]> {
    const embedder = await this.getEmbedder();
    const result = await embedder.embed(text);
    return Array.from(result);
  }

  /**
   * Embed multiple text strings
   */
  async embedMany(texts: string[]): Promise<number[][]> {
    const embedder = await this.getEmbedder();
    const results = await embedder.embedMany(texts);
    return results.map(r => Array.from(r));
  }

  /**
   * Clear the knowledge store
   */
  async clear(): Promise<void> {
    // Shutdown first to release locks
    await this.dispose();
    
    // Clear the storage
    await clearKnowledgeStoreInternal();
    
    // Reset state
    this.lifecycle = ServiceLifecycle.UNINITIALIZED;
  }

  /**
   * Get supported models
   */
  getSupportedModels(): ReadonlyArray<{ id: string; multilingual: boolean }> {
    return SUPPORTED_MODELS;
  }

  /**
   * Get model embedder configuration
   */
  getModelEmbedderConfig(modelId: string): {
    pooling: 'mean' | 'cls' | 'last_token';
    queryPrefix?: string;
    documentPrefix?: string;
    maxTokens?: number;
    batchSize?: number;
    charsPerToken?: number;
    useCache?: boolean;
  } {
    return getKnowledgeModelEmbedderConfig(modelId);
  }

  /**
   * Get model chunk configuration
   */
  getModelChunkConfig(modelId: string): { chunkSize: number; overlapPct: number } {
    return getKnowledgeModelChunkConfig(modelId);
  }
}
