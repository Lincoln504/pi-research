/**
 * Text Embedding Service using HuggingFace Transformers
 *
 * Provides embeddings for text using ONNX runtime with WebGPU/CPU support.
 * Includes automatic fallback from WebGPU to CPU on errors and idle timeout
 * to release GPU memory when not in use.
 */

import { type FeatureExtractionPipeline } from '@huggingface/transformers';

import { logger } from '../logger.ts';
import { safeUnref } from '../utils/safe-unref.ts';
import { metrics } from '../utils/metrics.ts';
import type { IStateManager } from '../core/service-interfaces.ts';
import type {
  EmbedderOptions,
  EmbedderState,
  DisposablePipeline,
} from '../core/interfaces/knowledge-interfaces.ts';
import {
  resetWebGpuFallbackFlag,
  hasWebGpuFallback,
  markWebGpuFallback,
  getModelCacheDir,
  registerGlobalEmbedder,
  unregisterGlobalEmbedder,
  initializeDawnWebGPU,
} from './embedder-utils.ts';
import { getHFEnv, initializeONNXEnv } from './onnx-env.ts';
import {
  isWebGpuDeviceError,
  isModelCached,
  acquireGpuLock,
  releaseGpuLock,
  loadPipelineWithTimeout,
  warmupPipeline,
  handleWebGPULoadError,
  handleWebGPUWarmupError,
} from './embedder-init.ts';

export { resetWebGpuFallbackFlag, hasWebGpuFallback, getModelCacheDir };
export type { EmbedderOptions, EmbedderState };

export class Embedder {
  private state: EmbedderState = 'idle';
  private pipeline: FeatureExtractionPipeline | null = null;
  private initializingPromise: Promise<void> | null = null;
  private disposePromise: Promise<void> | null = null;
  private recoveryPromise: Promise<void> | null = null;

  private model: string;
  private poolingMode: 'mean' | 'cls' | 'last_token';
  private queryPrefix: string;
  private dimension: number | null = null;
  private initializationTimeoutMs: number;
  private device: string;
  private maxTokens: number;
  private batchSize: number;
  private charsPerToken: number;
  private documentPrefix: string;
  private stateManager: IStateManager | null;
  private gpuLockHeld = false;
  private originalDevice: string;
  private useCache: boolean;
  private idleTimer: NodeJS.Timeout | null = null;
  private readonly IDLE_TIMEOUT_MS = 60 * 1000;
  private activeEmbeddings = 0;

  constructor(options: EmbedderOptions) {
    this.model = options.model;
    this.poolingMode = options.pooling ?? 'mean';
    this.queryPrefix = options.queryPrefix ?? '';
    this.initializationTimeoutMs = options.initializationTimeoutMs ?? 300000;
    this.originalDevice = options.device ?? 'webgpu';
    
    // Check for fallbacks
    const isWebGpu = this.originalDevice === 'webgpu';

    if (hasWebGpuFallback() && isWebGpu) {
      this.device = 'cpu';
      logger.info('[embedder] Skipping WebGPU (previous fallback detected), using CPU directly');
    } else {
      this.device = this.originalDevice;
    }

    this.maxTokens = options.maxTokens ?? 512;
    this.batchSize = options.batchSize ?? 8;
    this.charsPerToken = options.charsPerToken ?? 4;
    this.documentPrefix = options.documentPrefix ?? '';
    this.stateManager = options.stateManager ?? null;
    this.useCache = options.useCache ?? true;

    // Register this instance so the beforeExit handler can dispose it before
    // the ONNX C++ runtime tears down its global logger singleton (prevents crash).
    registerGlobalEmbedder(this);
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    this.idleTimer = setTimeout(() => {
      // FIX (#17): Only dispose if no embeddings are active, otherwise re-schedule
      if (this.activeEmbeddings > 0) {
        logger.debug(`[embedder] Idle timeout but ${this.activeEmbeddings} embeddings active, rescheduling...`);
        this.resetIdleTimer();
        return;
      }
      if (this.state === 'ready') {
        logger.info(`[embedder] Idle timeout reached (${this.IDLE_TIMEOUT_MS}ms), releasing GPU memory...`);
        this.dispose().catch(err => logger.warn('[embedder] Failed to dispose on idle:', err));
      }
    }, this.IDLE_TIMEOUT_MS);
    if (this.idleTimer) safeUnref(this.idleTimer);
  }

  private stopIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  async initialize(): Promise<void> {
    if (this.state === 'ready') return;
    if (this.state === 'disposing') {
      throw new Error('Cannot initialize while disposing');
    }

    // Lazy initialization of ONNX environment
    initializeONNXEnv();
    
    if (this.initializingPromise) {
      return this.initializingPromise;
    }

    this.state = 'initializing';
    this.initializingPromise = this._initializeInternal();

    try {
      await this.initializingPromise;
      const currentState = this.state as EmbedderState;
      if (currentState === 'disposing') {
        logger.warn('[embedder] Initialization finished but embedder was disposed in the meantime.');
        return;
      }
      this.state = 'ready';
    } catch (err) {
      this.state = 'failed';
      throw err;
    } finally {
      this.initializingPromise = null;
    }
  }

  private async _initializeInternal(): Promise<void> {
    try {
      // Acquire GPU lock if using WebGPU
      if (this.device === 'webgpu') {
        const { acquired, shouldFallback } = await acquireGpuLock(this.stateManager);
        if (shouldFallback) {
          this.device = 'cpu';
        } else if (acquired) {
          this.gpuLockHeld = true;
        }
      }

      // Try to initialize WebGPU via Dawn for Node.js environments
      if (this.device === 'webgpu') {
        await initializeDawnWebGPU();
      }

      const cached = await isModelCached(this.model);
      logger.info(
        `[embedder] Loading model: ${this.model} (${cached ? 'from local cache' : 'downloading from HuggingFace'})...`
      );

      const env = getHFEnv();
      const prevAllowRemote = env.allowRemoteModels;
      if (cached) {
        env.allowRemoteModels = false;
      }

      try {
        const timeoutMs = cached ? 30_000 : this.initializationTimeoutMs;
        const { pipeline: loadedPipeline } = await loadPipelineWithTimeout(this.model, this.device, timeoutMs, this.useCache);
        this.pipeline = loadedPipeline;
        logger.info(`[embedder] Pipeline loaded (device: ${this.device})`);
      } catch (loadErr) {
        if (this.device === 'webgpu' && isWebGpuDeviceError(loadErr)) {
          const result = await handleWebGPULoadError(
            loadErr,
            this.pipeline,
            this.stateManager,
            this.gpuLockHeld,
            this.model,
            this.initializationTimeoutMs,
            this.useCache
          );
          if (!result.success) {
            throw result.error;
          }
          this.pipeline = result.pipeline ?? null;
          this.device = 'cpu';
          this.gpuLockHeld = false;
        } else {
          throw loadErr;
        }
      } finally {
        env.allowRemoteModels = prevAllowRemote;
      }

      // Warmup
      let dummy: any;
      try {
        const warmupResult = await warmupPipeline(this.pipeline!, this.poolingMode, this.useCache);
        if (!warmupResult.success) {
          throw warmupResult.error;
        }
        dummy = warmupResult.dummy;
      } catch (warmupErr) {
        if (this.device === 'webgpu' && isWebGpuDeviceError(warmupErr)) {
          const result = await handleWebGPUWarmupError(
            warmupErr as Error,
            this.pipeline,
            this.stateManager,
            this.gpuLockHeld,
            this.model,
            this.initializationTimeoutMs,
            this.useCache
          );
          if (!result.success) {
            throw result.error;
          }
          this.pipeline = result.pipeline ?? null;
          this.device = 'cpu';
          this.gpuLockHeld = false;
          dummy = result.dummy;
        } else {
          throw warmupErr;
        }
      }
      
      this.dimension = dummy.dims[dummy.dims.length - 1] ?? null;

      await releaseGpuLock(this.stateManager, this.gpuLockHeld);
      this.gpuLockHeld = false;

      logger.info(`[embedder] Ready. Dimension: ${this.dimension}, device: ${this.device}`);
    } catch (err) {
      await releaseGpuLock(this.stateManager, this.gpuLockHeld);
      this.gpuLockHeld = false;
      if (this.pipeline) {
        try { if (typeof (this.pipeline as any).dispose === 'function') await (this.pipeline as DisposablePipeline).dispose(); } catch (err) { logger.warn('[embedder] Error disposing pipeline:', err); }
        this.pipeline = null;
      }
      logger.error(`[embedder] Failed to initialize:`, err);
      throw err;
    }
  }

  isInitialized(): boolean {
    return this.state === 'ready' && this.pipeline !== null && this.dimension !== null;
  }

  getDevice(): string {
    return this.device;
  }

  getOriginalDevice(): string {
    return this.originalDevice;
  }

  getDimension(): number | null {
    return this.dimension;
  }

  /**
   * Set the embedding dimension explicitly.
   * Used by KnowledgeStore when restoring dimension from an existing table schema
   * before the embedder has been fully warmed up.
   */
  setDimension(dim: number): void {
    this.dimension = dim;
  }

  private pipelineOpts(): { pooling: 'mean' | 'cls' | 'last_token'; normalize: boolean; use_cache?: boolean } {
    return {
      pooling: this.poolingMode as 'mean' | 'cls' | 'last_token',
      normalize: true,
      ...(this.useCache === false ? { use_cache: false } : {}),
    };
  }

  private truncateText(text: string): string {
    const maxChars = this.maxTokens * this.charsPerToken;
    return text.length > maxChars ? text.slice(0, maxChars) : text;
  }

  async embed(text: string): Promise<Float32Array> {
    await this.initialize();
    // Compute the input BEFORE the active-count increment: truncateText is a pure
    // string op, and keeping it (and nothing else) ahead of the try/finally means
    // every path that can throw or await is inside the finally that decrements the
    // counter. Otherwise a throw here (or in acquireGpuLock) would leak the count,
    // permanently wedging recoverToCpu (15s spin) and dispose (5s hang).
    const input = this.truncateText(this.queryPrefix ? this.queryPrefix + text : text);
    this.stopIdleTimer();
    this.activeEmbeddings++;

    let lockAcquired = false;
    try {
      if (this.device === 'webgpu' && this.stateManager) {
        lockAcquired = await this.stateManager.acquireGpuLock(undefined, 15_000);
        if (!lockAcquired) {
          logger.warn('[embedder] GPU per-call lock timeout after 15s — proceeding without lock');
        }
      }
      const output = await logger.runCapturingStderr(async () => {
        return await this.pipeline!(input, this.pipelineOpts());
      });
      return output.data as Float32Array;
    } catch (err) {
      if (isWebGpuDeviceError(err)) {
        if (lockAcquired && this.stateManager) {
          await this.stateManager.releaseGpuLock().catch(err => {
            logger.warn('[embedder] Failed to release GPU lock:', err);
          });
          lockAcquired = false;
        }
        await this.recoverToCpu();
        const output = await logger.runCapturingStderr(async () => {
          return await this.pipeline!(input, this.pipelineOpts());
        });
        return output.data as Float32Array;
      }
      throw err;
    } finally {
      if (lockAcquired && this.stateManager) {
        await this.stateManager.releaseGpuLock().catch((err) => logger.warn('[embedder] Failed to release per-call GPU lock:', err));
      }
      this.activeEmbeddings--;
      this.resetIdleTimer();
    }
  }

  async embedMany(texts: string[]): Promise<Float32Array[]> {
    await this.initialize();
    this.stopIdleTimer();

    return metrics.measure('embedMany_latency', async () => {
      // Increment INSIDE the measured closure and inside the try/finally below, so
      // the dimension-null throw and acquireGpuLock can't leak the active count
      // (the increment used to sit outside this closure while the decrement was in
      // the finally — a throw before the try wedged the counter permanently).
      this.activeEmbeddings++;
      let lockAcquired = false;
      try {
        const dim = this.getDimension();
        if (dim === null) throw new Error('Embedder not initialized (dimension unknown)');
        const results: Float32Array[] = [];

        if (this.device === 'webgpu' && this.stateManager) {
          lockAcquired = await this.stateManager.acquireGpuLock(undefined, 45_000);
          if (!lockAcquired) {
            logger.warn('[embedder] GPU batch lock timeout after 45s — proceeding without lock');
          }
        }

        for (let i = 0; i < texts.length; i += this.batchSize) {
          const batch = texts.slice(i, i + this.batchSize).map(t => {
            const truncated = this.truncateText(t);
            return this.documentPrefix ? this.documentPrefix + truncated : truncated;
          });

          let output: any;
          try {
            output = await logger.runCapturingStderr(async () => {
              return await this.pipeline!(batch, this.pipelineOpts());
            });
          } catch (err) {
            if (isWebGpuDeviceError(err)) {
              if (lockAcquired && this.stateManager) {
                await this.stateManager.releaseGpuLock().catch(err => {
            logger.warn('[embedder] Failed to release GPU lock:', err);
          });
                lockAcquired = false;
              }
              await this.recoverToCpu();
              output = await logger.runCapturingStderr(async () => {
                return await this.pipeline!(batch, this.pipelineOpts());
              });
            } else {
              throw err;
            }
          }

          for (let j = 0; j < batch.length; j++) {
            results.push(output.data.slice(j * dim, (j + 1) * dim) as Float32Array);
          }
        }
        return results;
      } finally {
        if (lockAcquired && this.stateManager) {
          await this.stateManager.releaseGpuLock().catch(err => {
            logger.warn('[embedder] Failed to release GPU lock:', err);
          });
        }
        this.activeEmbeddings--;
        this.resetIdleTimer();
      }
    });
  }

  private async recoverToCpu(): Promise<void> {
    if (this.recoveryPromise) return this.recoveryPromise;

    // Guard: if disposal has already started, skip recovery — the embedder is going away.
    if (this.state === 'disposing' || this.state === 'idle') {
      logger.debug('[embedder] recoverToCpu called during disposal/idle — skipping');
      return;
    }

    this.recoveryPromise = (async () => {
      logger.warn('[embedder] WebGPU device error detected during operation — falling back to CPU for the remainder of this session');
      
      markWebGpuFallback();
      
      await releaseGpuLock(this.stateManager, this.gpuLockHeld);
      this.gpuLockHeld = false;
      
      this.state = 'initializing';
      
      // Wait for other concurrent embeddings to finish before disposing the pipeline
      const maxWaitMs = 15000;
      const startTime = Date.now();
      // We expect activeEmbeddings to be at least 1 (the current caller).
      // If multiple callers are in recoverToCpu, they all wait for recoveryPromise.
      while (this.activeEmbeddings > 1 && (Date.now() - startTime) < maxWaitMs) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      if (this.pipeline) {
        try { if (typeof (this.pipeline as any).dispose === 'function') await (this.pipeline as DisposablePipeline).dispose(); } catch (err) { logger.warn('[embedder] Error disposing pipeline:', err); }
        this.pipeline = null;
      }
      this.device = 'cpu';
      
      this.initializingPromise = this._initializeInternal();
      try {
          await this.initializingPromise;
          this.state = 'ready';
      } catch (e) {
          this.state = 'failed';
          throw e;
      } finally {
          this.initializingPromise = null;
      }
      logger.warn('[embedder] CPU fallback recovery complete.');
    })();

    try {
      await this.recoveryPromise;
    } finally {
      this.recoveryPromise = null;
    }
  }

  async dispose(): Promise<void> {
    if (this.state === 'idle') return;
    this.stopIdleTimer();

    if (this.state === 'disposing' && this.disposePromise) {
      return this.disposePromise;
    }

    this.state = 'disposing';
    this.disposePromise = (async () => {
      // Wait for all active embeddings to complete
      const maxWaitMs = 5000;
      const startTime = Date.now();
      while (this.activeEmbeddings > 0 && (Date.now() - startTime) < maxWaitMs) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      if (this.activeEmbeddings > 0) {
        logger.warn(`[embedder] Disposing with ${this.activeEmbeddings} active embeddings (timed out)`);
      }

      if (this.initializingPromise) {
        try {
          await this.initializingPromise;
        } catch (_e) {
          // Initialize failed, which is fine
        }
      }

      if (this.pipeline) {
        try {
          if (typeof (this.pipeline as any).dispose === 'function') {
            await (this.pipeline as DisposablePipeline).dispose();
          }
        } catch (err) {
          logger.warn('[embedder] Error during pipeline dispose:', err);
        }
        this.pipeline = null;
      }

      // Release GPU lock if still held (shouldn't happen after normal init, but safe for edge cases)
      await releaseGpuLock(this.stateManager, this.gpuLockHeld);
      // Always try to release on dispose for safety (test expects this)
      if (this.stateManager) {
        await this.stateManager.releaseGpuLock().catch(err => {
          logger.warn('[embedder] Failed to release GPU lock during dispose:', err);
        });
      }
      this.gpuLockHeld = false;

      this.state = 'idle';
      this.disposePromise = null;

      // Unregister from the global beforeExit handler — cleanup is done.
      unregisterGlobalEmbedder();
    })();

    return this.disposePromise;
  }
}