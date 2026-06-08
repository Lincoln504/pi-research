/**
 * Knowledge Store Service
 *
 * Service wrapper for the knowledge store functionality.
 * Provides clean interface for embedding and storage operations.
 */

import { ServiceLifecycle, getService } from '../core/service-registry.ts';
import { ServiceNames } from '../core/interfaces/service-names.ts';
import { logger } from '../logger.ts';
import type { IEmbedder, IKnowledgeStore, IKnowledgeStoreService, IWriterQueue } from '../core/service-interfaces.ts';
import { FileLockService } from './file-lock-service.ts';
import { StatePathConfiguration } from './state/state-path-configuration.ts';
import * as path from 'node:path';

// Static imports from knowledge module
import {
  createKnowledgeStoreComponents,
  forceDeleteKnowledgeStore,
  SUPPORTED_MODELS,
  getModelEmbedderConfig as getKnowledgeModelEmbedderConfig,
  getModelChunkConfig as getKnowledgeModelChunkConfig,
} from '../knowledge/index.ts';
import { getEmbedder, clearEmbeddingInstance } from './embedding/embedding-factory.ts';
import { getConfig } from '../config.ts';

/**
 * Knowledge Store Service Implementation
 */
export class KnowledgeStoreService implements IKnowledgeStoreService {
  readonly name = ServiceNames.KNOWLEDGE_STORE;
  lifecycle = ServiceLifecycle.UNINITIALIZED;

  // Knowledge store components
  private _embedder: IEmbedder | null = null;
  private _store: IKnowledgeStore | null = null;
  private _writerQueue: IWriterQueue | null = null;
  private _initLock: FileLockService | null = null;

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
        const config = getConfig();
        const embedderFactory = () => getEmbedder(config);
        const reconnectFactory = async () => {
          clearEmbeddingInstance();
          return getEmbedder(config);
        };

        // Acquire lock for initialization/migration
        const pathConfig = await getService<StatePathConfiguration>(ServiceNames.STATE_PATH_CONFIGURATION);
        const lockPath = path.join(pathConfig.getLockDirPath(), 'knowledge-store-init.lock');
        
        // Re-use or create the init lock
        if (!this._initLock) {
          // Increase threshold to 60s because createKnowledgeStoreComponents retries for ~15-20s total
          // and we want to avoid lock theft during this critical initialization phase.
          this._initLock = new FileLockService({ 
            lockFilePath: lockPath,
            lockStaleThreshold: 60000
          });
          await this._initLock.initialize();
        }

        const initLock = this._initLock;
        let components;
        try {
          components = await initLock.withLock(async () => {
            return createKnowledgeStoreComponents(embedderFactory, reconnectFactory, (fn) => initLock.withLock(fn));
          });
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          // Detect LanceDB corruption (often due to 0-byte manifest/txn files after a crash)
          if (errorMsg.includes('Generic memory error') && errorMsg.includes('Invalid range 0..0')) {
            logger.warn('[KnowledgeStoreService] Detected corrupted Knowledge Store. Clearing and retrying initialization...');
            try {
              await forceDeleteKnowledgeStore();
              components = await initLock.withLock(async () => {
                return createKnowledgeStoreComponents(embedderFactory, reconnectFactory, (fn) => initLock.withLock(fn));
              });
            } catch (retryErr) {
              logger.error('[KnowledgeStoreService] Retry after clearing store failed:', retryErr);
              throw retryErr;
            }
          } else {
            throw err;
          }
        }

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

      if (this._initLock) {
        await this._initLock.dispose();
      }

      this._embedder = null;
      this._store = null;
      this._writerQueue = null;
      this._initLock = null;

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
   * Clear the knowledge store (all entries)
   */
  async clear(): Promise<void> {
    const store = await this.getStore();
    // Clear everything by using a filter that matches everything
    await store.clear('1 = 1');
  }

  /**
   * Clear only local project entries
   */
  async clearLocal(): Promise<void> {
    const store = await this.getStore();
    const workspace = process.cwd().replace(/'/g, "''");
    await store.clear(`workspace = '${workspace}'`);
  }

  /**
   * Clear only global entries
   */
  async clearGlobal(): Promise<void> {
    const store = await this.getStore();
    await store.clear('is_global = true');
  }

  /**
   * Export the knowledge store for web use.
   */
  async exportForWeb(outputPath: string): Promise<void> {
    const store = await this.getStore();
    await store.exportForWeb(outputPath);
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
