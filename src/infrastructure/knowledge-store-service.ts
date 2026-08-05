/**
 * Knowledge Store Service
 *
 * Service wrapper for the knowledge store functionality.
 * Provides clean interface for embedding and storage operations.
 */

import { ServiceLifecycle, getService, tryGetServiceContainerFromCtx } from '../core/service-registry.ts';
import { ServiceNames } from '../core/interfaces/service-names.ts';
import { logger } from '../logger.ts';
import type { IEmbedder, IKnowledgeStore, IKnowledgeStoreService, IWriterQueue, IProcessLifecycle } from '../core/service-interfaces.ts';
import { FileLockService } from './file-lock-service.ts';
import { StatePathConfiguration } from './state/state-path-configuration.ts';
import * as path from 'node:path';
import { normalizeWorkspacePath } from '../utils/text-utils.ts';

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
import { isNativeStackUnavailableError } from '../knowledge/embedder-utils.ts';

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
  private _cwd: string = process.cwd();

  // Why the service last went DISABLED. 'mode' (Knowledge Mode = none) is revivable — a
  // later /research-config change re-enables it without a Pi restart. 'native' (missing
  // onnxruntime/lancedb binding) is permanent on this platform, so it stays memoized.
  private _disabledReason: 'mode' | 'native' | null = null;

  // The KNOWLEDGE_STORE_MODE the live store was last built with. Lets initialize() detect a runtime
  // mode change (project↔global re-scope, or enabled→none) and re-initialize so a /research-config
  // change applies without a Pi restart — not just the DISABLED→enabled revival.
  private _initializedMode: string | undefined = undefined;

  // Initialization promise to prevent concurrent initialization
  private _initializationPromise: Promise<void> | null = null;

  async initialize(ctx?: any): Promise<void> {
    // Only an EXPLICIT ctx.cwd may re-scope the store. The lazy callers
    // (getStore/getEmbedder/getWriterQueue) call initialize() with no ctx — they
    // must NOT flip the scope. Resolving the missing cwd to process.cwd() here was
    // a scoping bug: when the pi host's process.cwd() differs from the session's
    // ctx.cwd (e.g. pi launched from ~ but working in ~/projA), every getStore()
    // disposed the correctly-scoped store and rebuilt it against process.cwd(),
    // so reads/writes silently scoped to the wrong workspace. Falling back to the
    // already-resolved this._cwd keeps the scope stable across lazy calls.
    const newCwd = ctx?.cwd || this._cwd;

    // If already settled for this cwd, return early — UNLESS the live Knowledge Mode has changed
    // since we initialized (via /research-config), in which case re-initialize so the change
    // applies without a Pi restart:
    //  - DISABLED('mode') and mode is now != 'none'   : was off, now enabled → revive.
    //  - INITIALIZED and mode != the built mode        : project↔global re-scope, or enabled→'none'.
    // A native-unavailable DISABLED ('native') stays memoized — retrying is futile on that platform.
    if ((this.lifecycle === ServiceLifecycle.INITIALIZED || this.lifecycle === ServiceLifecycle.DISABLED) && this._cwd === newCwd) {
      const liveMode: string = (ctx?.config || getConfig(this._cwd)).KNOWLEDGE_STORE_MODE;
      // Reviving a DISABLED store creates handles (no live state to tear down), so it is safe even
      // from a lazy call and uses the live config. Re-scoping/disabling a LIVE (INITIALIZED) store,
      // however, disposes handles — restrict that to an EXPLICIT ctx.config (mirrors the ctx.cwd
      // invariant): a lazy getStore() reads the base getConfig, which can differ from the
      // iface-resolved config the store was built with, and must never dispose out from under a run.
      const reviveFromMode =
        this.lifecycle === ServiceLifecycle.DISABLED && this._disabledReason === 'mode' && liveMode !== 'none';
      const modeChanged =
        this.lifecycle === ServiceLifecycle.INITIALIZED &&
        ctx?.config !== undefined &&
        this._initializedMode !== undefined &&
        this._initializedMode !== ctx.config.KNOWLEDGE_STORE_MODE;
      if (!reviveFromMode && !modeChanged) {
        return;
      }
      logger.log(`[KnowledgeStoreService] Knowledge Mode changed (${this._initializedMode ?? this._disabledReason} → ${liveMode}); re-initializing store (no restart needed).`);
      // An INITIALIZED store holds live handles (embedder/LanceDB/writer) — dispose before rebuilding.
      if (this.lifecycle === ServiceLifecycle.INITIALIZED) {
        await this.dispose();
      }
    }

    // If CWD changed, we must dispose the old store and re-initialize.
    // This applies to both INITIALIZED and DISABLED states — if the service
    // is disabled in one project but the new project has knowledge mode enabled,
    // we need to re-initialize.
    if ((this.lifecycle === ServiceLifecycle.INITIALIZED || this.lifecycle === ServiceLifecycle.DISABLED) && this._cwd !== newCwd) {
      logger.log(`[KnowledgeStoreService] CWD changed from ${this._cwd} to ${newCwd}. Re-initializing store...`);
      await this.dispose();
    }

    // Return existing initialization promise if in progress for the same CWD
    if (this._initializationPromise && this._cwd === newCwd) {
      return this._initializationPromise;
    }

    // A different-cwd (or post-dispose-gate) call while an init is still in flight
    // must NOT start a second closure: the two would race assignments to
    // _embedder/_store/_writerQueue (the loser's components leak un-disposed), and
    // the first to settle would null the second's promise marker — letting a
    // concurrent dispose() skip its wait-for-init guard and be resurrected when the
    // straggler flips lifecycle back to INITIALIZED. Settle the in-flight init
    // first, then fall through to the normal re-init path.
    while (this._initializationPromise) {
      await this._initializationPromise.catch(() => { /* its own catch reset state */ });
      // A newer init may have started while we awaited (or while dispose() below
      // yielded); if it covers our cwd, join it — the loop re-checks either way.
      if (this._initializationPromise && this._cwd === newCwd) {
        return this._initializationPromise;
      }
      if (this.lifecycle === ServiceLifecycle.INITIALIZED || this.lifecycle === ServiceLifecycle.DISABLED) {
        if (this._cwd !== newCwd) {
          logger.log(`[KnowledgeStoreService] CWD changed from ${this._cwd} to ${newCwd}. Re-initializing store...`);
          await this.dispose();
        } else {
          // The settled init already covers this cwd.
          return;
        }
      }
    }

    this.lifecycle = ServiceLifecycle.INITIALIZING;
    logger.debug('[KnowledgeStoreService] Initializing...');

    // `let ... = null` (not const): if the closure throws BEFORE its first await,
    // the finally runs synchronously during the IIFE call — a const self-reference
    // would be a TDZ crash. The null guard in the finally covers that window (the
    // marker was never published, so there is nothing to clear).
    let initPromise: Promise<void> | null = null;
    initPromise = (async () => {
      try {
        // Create the knowledge store components.
        // Prefer an explicit ctx.cwd; otherwise keep the cwd already resolved on this
        // service (defaults to process.cwd() on a never-initialized instance). This
        // mirrors the newCwd resolution above so a lazy getStore() never re-scopes.
        this._cwd = ctx?.cwd || this._cwd;
        // Prefer a caller-resolved config (the SDK/CLI/tool seed ctx.config with the
        // interface-resolved overlay); else load this directory's config.
        const config = ctx?.config || getConfig(this._cwd);
        // Record the mode this build reflects so a later runtime mode change is detected above.
        this._initializedMode = config.KNOWLEDGE_STORE_MODE;
        const embedderFactory = () => getEmbedder(config);
        const reconnectFactory = async () => {
          // MUST await: clearEmbeddingInstance() only nulls the cached instance AFTER its
          // internal `await instance.dispose()` resolves. Without awaiting, getEmbedder(config)
          // runs while the old instance is still cached and (for unchanged config) returns that
          // same still-disposing instance — so the reconnect hands back the very embedder it
          // was trying to replace on a leader handoff.
          await clearEmbeddingInstance();
          return getEmbedder(config);
        };

        // Acquire lock for initialization/migration
        const container = tryGetServiceContainerFromCtx(ctx);
        const pathConfig = await getService<StatePathConfiguration>(ServiceNames.STATE_PATH_CONFIGURATION, undefined, container);
        const lockPath = path.join(pathConfig.getLockDirPath(), 'knowledge-store-init.lock');
        
        // Re-use or create the init lock
        if (!this._initLock) {
          // Increase threshold to 60s because createKnowledgeStoreComponents retries for ~15-20s total
          // and we want to avoid lock theft during this critical initialization phase.
          const processLifecycle = await getService<IProcessLifecycle>(ServiceNames.PROCESS_LIFECYCLE, undefined, container);
          this._initLock = new FileLockService({
            lockFilePath: lockPath,
            lockStaleThreshold: 60000,
            processLifecycle,
          });
          await this._initLock.initialize();
        }

        const initLock = this._initLock;
        let components;
        try {
          components = await initLock.withLock(async () => {
            return createKnowledgeStoreComponents(
              embedderFactory, 
              reconnectFactory, 
              (fn) => initLock.withLock(fn),
              config,
              this._cwd
            );
          });
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          // Detect LanceDB corruption (often due to 0-byte manifest/txn files after a crash)
          if (errorMsg.includes('Generic memory error') && errorMsg.includes('Invalid range 0..0')) {
            logger.warn('[KnowledgeStoreService] Detected corrupted Knowledge Store. Clearing and retrying initialization...');
            try {
              await forceDeleteKnowledgeStore(config, this._cwd);
              components = await initLock.withLock(async () => {
                return createKnowledgeStoreComponents(
                  embedderFactory, 
                  reconnectFactory, 
                  (fn) => initLock.withLock(fn),
                  config,
                  this._cwd
                );
              });
            } catch (retryErr) {
              logger.error('[KnowledgeStoreService] Retry after clearing store failed:', retryErr);
              throw retryErr;
            }
          } else {
            throw err;
          }
        }

        if (!components) {
          logger.debug('[KnowledgeStoreService] Knowledge store is disabled. Setting lifecycle to DISABLED.');
          this.lifecycle = ServiceLifecycle.DISABLED;
          this._disabledReason = 'mode';
          this._embedder = null;
          this._store = null;
          this._writerQueue = null;
          return;
        }

        this._embedder = components.embedder;
        this._store = components.store;
        this._writerQueue = components.writerQueue;

        const originalDevice = this._embedder?.getOriginalDevice() ?? '(unknown)';
        const actualDevice = this._embedder?.isInitialized() ? (this._embedder.getDevice() ?? '(deferred)') : '(deferred)';
        
        logger.debug(`[KnowledgeStoreService] Initialized. Device: ${actualDevice} (original: ${originalDevice})`);

        this.lifecycle = ServiceLifecycle.INITIALIZED;
        this._disabledReason = null;
      } catch (err) {
        // A genuinely missing native binding (e.g. Intel macOS / darwin-x64, which
        // has no onnxruntime-node nor @lancedb prebuilt) will never succeed on a
        // retry. Memoize it as DISABLED so every later getStore()/embed() degrades
        // gracefully instead of re-running the full init + retry/backoff storm.
        if (isNativeStackUnavailableError(err)) {
          logger.warn('[KnowledgeStoreService] Native ML/vector stack unavailable on this platform; disabling the knowledge store.');
          this.lifecycle = ServiceLifecycle.DISABLED;
          this._disabledReason = 'native';
          this._embedder = null;
          this._store = null;
          this._writerQueue = null;
          return;
        }
        logger.error('[KnowledgeStoreService] Initialization failed:', err);
        this.lifecycle = ServiceLifecycle.UNINITIALIZED;
        throw err;
      } finally {
        // Identity-guarded (same pattern as embedding-factory's clearIfCurrent): only
        // the promise that owns the marker may null it, so a settling straggler can
        // never disarm a newer init's marker — which dispose() relies on to wait out
        // in-flight work.
        if (this._initializationPromise === initPromise) {
          this._initializationPromise = null;
        }
      }
    })();
    this._initializationPromise = initPromise;

    return initPromise;
  }

  async dispose(): Promise<void> {
    if (this.lifecycle === ServiceLifecycle.DISPOSED || this.lifecycle === ServiceLifecycle.UNINITIALIZED) {
      return;
    }

    // If an initialization is still in flight, let it finish before we tear down.
    // Otherwise the init closure would re-assign this._embedder/_store/_writerQueue
    // and flip lifecycle back to INITIALIZED *after* dispose() nulled everything —
    // resurrecting a disposed service with live, never-disposed components (leaked
    // ONNX sessions + LanceDB handles) that isReady() then reports as ready.
    if (this._initializationPromise) {
      try {
        await this._initializationPromise;
      } catch {
        // init failed; its own catch already reset state — nothing to wait on.
      }
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

  /** The working directory this service initialized against (from ctx.cwd). */
  getCwd(): string {
    return this._cwd;
  }

  getDisabledReason(): 'mode' | 'native' | null {
    return this._disabledReason;
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
  async getEmbedder(): Promise<IEmbedder | null> {
    await this.initialize();
    if (this.lifecycle === ServiceLifecycle.DISABLED) {
      return null;
    }
    if (!this._embedder) {
      throw new Error('[KnowledgeStoreService] Embedder not initialized');
    }
    return this._embedder;
  }

  /**
   * Get the knowledge store instance
   */
  async getStore(): Promise<IKnowledgeStore | null> {
    await this.initialize();
    if (this.lifecycle === ServiceLifecycle.DISABLED) {
      return null;
    }
    if (!this._store) {
      throw new Error('[KnowledgeStoreService] Store not initialized');
    }
    return this._store;
  }

  /**
   * Get the writer queue instance
   */
  async getWriterQueue(): Promise<IWriterQueue | null> {
    await this.initialize();
    if (this.lifecycle === ServiceLifecycle.DISABLED) {
      return null;
    }
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
    if (!embedder) {
      throw new Error('[KnowledgeStoreService] Embedder not available (store disabled)');
    }
    const result = await embedder.embed(text);
    return Array.from(result);
  }

  /**
   * Embed multiple text strings
   */
  async embedMany(texts: string[]): Promise<number[][]> {
    const embedder = await this.getEmbedder();
    if (!embedder) {
      throw new Error('[KnowledgeStoreService] Embedder not available (store disabled)');
    }
    const results = await embedder.embedMany(texts);
    return results.map(r => Array.from(r));
  }

  /**
   * Clear the knowledge store entries for the current scope.
   *
   * In 'global' mode, clears only global entries (is_global = true).
   * In 'project' mode, clears only this workspace's entries.
   * In 'none' mode, no-op (store is disabled).
   */
  async clear(): Promise<void> {
    const config = getConfig(this._cwd);
    if (config.KNOWLEDGE_STORE_MODE === 'global') {
      await this.clearGlobal();
    } else if (config.KNOWLEDGE_STORE_MODE === 'project') {
      await this.clearLocal();
    }
    // 'none' mode: no-op (store is disabled, nothing to clear)
  }

  /**
   * Clear only local project entries (workspace-scoped, NOT global).
   * Entries that are both local AND global are left alone — use clearGlobal
   * for those.
   */
  async clearLocal(): Promise<void> {
    const store = await this.getStore();
    if (!store) return;
    
    // Normalize workspace path to match how entries are stored (see KnowledgeStore.getWorkspace)
    const workspace = normalizeWorkspacePath(this._cwd);
    const escaped = workspace.replace(/'/g, "''");
    
    // Delete all entries that were contributed from this project workspace.
    // If they were shared globally, they will also be removed from the global view.
    await store.clear(`workspace = '${escaped}'`);
  }

  /**
   * Clear only global entries (cross-project, visible to all workspaces).
   */
  async clearGlobal(): Promise<void> {
    const store = await this.getStore();
    if (store) {
      await store.clear('is_global = true');
    }
  }

  /**
   * Export the knowledge store for web use.
   */
  async exportForWeb(outputPath: string): Promise<void> {
    const store = await this.getStore();
    if (store) {
      await store.exportForWeb(outputPath);
    }
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
