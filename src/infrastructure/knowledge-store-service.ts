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
  initKnowledgeStore as initKnowledgeStoreInternal,
  shutdownKnowledgeStore as shutdownKnowledgeStoreInternal,
  clearKnowledgeStore as clearKnowledgeStoreInternal,
  getEmbedder as getKnowledgeEmbedder,
  getStore as getKnowledgeStoreInternal,
  getWriterQueue as getKnowledgeWriterQueueInternal,
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
        // Import and initialize the knowledge store
        await initKnowledgeStoreInternal();

        // Get the initialized components
        this._embedder = await getKnowledgeEmbedder();
        this._store = await getKnowledgeStoreInternal();
        this._writerQueue = await getKnowledgeWriterQueueInternal();

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
    if (this.lifecycle === ServiceLifecycle.DISPOSED) {
      return;
    }

    this.lifecycle = ServiceLifecycle.DISPOSING;
    logger.debug('[KnowledgeStoreService] Disposing...');

    try {
      // Import and shutdown the knowledge store
      await shutdownKnowledgeStoreInternal();

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
    // Convert Float32Array to number array if needed
    return Array.isArray(result) ? result : Array.from(result);
  }

  /**
   * Embed multiple text strings
   */
  async embedMany(texts: string[]): Promise<number[][]> {
    const embedder = await this.getEmbedder();
    const results = await embedder.embedMany(texts);
    // Convert Float32Array to number array if needed
    return results.map(r => Array.isArray(r) ? r : Array.from(r));
  }

  /**
   * Clear the knowledge store
   */
  async clear(): Promise<void> {
    await clearKnowledgeStoreInternal();
    
    // Re-initialize after clearing
    this._embedder = null;
    this._store = null;
    this._writerQueue = null;
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

// ============================================================================
// Singleton Accessor (for backward compatibility)
// ============================================================================

let _knowledgeStoreServiceInstance: KnowledgeStoreService | null = null;

/**
 * Get or create the knowledge store service instance
 */
export function getKnowledgeStoreService(): KnowledgeStoreService {
  if (!_knowledgeStoreServiceInstance) {
    _knowledgeStoreServiceInstance = new KnowledgeStoreService();
    _knowledgeStoreServiceInstance.initialize().catch(err => {
      logger.error('[KnowledgeStoreService] Failed to initialize:', err);
    });
  }
  return _knowledgeStoreServiceInstance;
}

/**
 * Reset the knowledge store service instance
 * Primarily used for testing
 */
export function resetKnowledgeStoreService(): void {
  if (_knowledgeStoreServiceInstance) {
    _knowledgeStoreServiceInstance.dispose().catch(err => {
      logger.error('[KnowledgeStoreService] Failed to dispose:', err);
    });
  }
  _knowledgeStoreServiceInstance = null;
}

/**
 * Get the embedder (backward compatibility)
 */
export async function getEmbedder(): Promise<IEmbedder> {
  const service = getKnowledgeStoreService();
  return service.getEmbedder();
}

/**
 * Get the store (backward compatibility)
 */
export async function getStore(): Promise<IKnowledgeStore> {
  const service = getKnowledgeStoreService();
  return service.getStore();
}

/**
 * Get the writer queue (backward compatibility)
 */
export async function getWriterQueue(): Promise<IWriterQueue> {
  const service = getKnowledgeStoreService();
  return service.getWriterQueue();
}

/**
 * Check if knowledge store is ready (backward compatibility)
 */
export function isKnowledgeStoreReady(): boolean {
  const service = getKnowledgeStoreService();
  return service.isReady();
}

/**
 * Initialize knowledge store (backward compatibility)
 */
export async function initKnowledgeStore(): Promise<void> {
  const service = getKnowledgeStoreService();
  return service.initialize();
}

/**
 * Shutdown knowledge store (backward compatibility)
 */
export async function shutdownKnowledgeStore(): Promise<void> {
  const service = getKnowledgeStoreService();
  return service.dispose();
}

/**
 * Clear knowledge store (backward compatibility)
 */
export async function clearKnowledgeStore(): Promise<void> {
  const service = getKnowledgeStoreService();
  return service.clear();
}