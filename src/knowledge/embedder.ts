import { pipeline, env, type FeatureExtractionPipeline } from '@huggingface/transformers';
import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import * as os from 'node:os';
import { logger, getLogger } from '../logger.ts';
import { metrics } from '../utils/metrics.ts';
import type { StateManager } from '../infrastructure/state-manager.ts';

/**
 * ONNX runtime environment
 */
interface ONNXRuntimeEnv {
  logLevel?: string;
  debug?: boolean;
}

/**
 * HuggingFace environment with ONNX support
 */
interface HFEnv {
  cacheDir: string;
  onnx?: ONNXRuntimeEnv;
}

/**
 * Disposable pipeline interface
 */
interface DisposablePipeline {
  dispose(): Promise<void>;
}

/**
 * Feature extraction pipeline with device option
 */
interface FeatureExtractionPipelineWithDevice extends FeatureExtractionPipeline {
  device?: 'webgpu' | 'cpu' | 'auto' | 'gpu' | 'wasm' | 'cuda' | 'dml' | 'coreml' | 'webnn' | 'webnn-npu' | 'webnn-gpu' | 'webnn-cpu';
}

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
  stateManager?: StateManager;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMessage: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
      if (timer.unref) timer.unref(); 
    }),
  ]);
}

export function getModelCacheDir(): string {
  const xdgCache = process.env['XDG_CACHE_HOME'];
  const base = xdgCache ?? path.join(os.homedir(), '.cache');
  return path.join(base, 'pi-research', 'models');
}

env.cacheDir = getModelCacheDir();

try {
  const _nodeRequire = createRequire(import.meta.url);
  const { env: ortEnv } = _nodeRequire('onnxruntime-common') as { env: { logLevel?: string } };
  if (ortEnv) ortEnv.logLevel = 'error';
} catch { /* ignore */ }

type EmbedderState = 'idle' | 'initializing' | 'ready' | 'failed' | 'disposing';

export class Embedder {
  private state: EmbedderState = 'idle';
  private pipeline: FeatureExtractionPipeline | null = null;
  private initializingPromise: Promise<void> | null = null;
  private disposePromise: Promise<void> | null = null;

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
  private stateManager: StateManager | null;
  private gpuLockHeld = false;

  constructor(options: EmbedderOptions) {
    this.model = options.model;
    this.poolingMode = options.pooling ?? 'mean';
    this.queryPrefix = options.queryPrefix ?? '';
    this.initializationTimeoutMs = options.initializationTimeoutMs ?? 120000;
    this.device = options.device ?? 'webgpu';
    this.maxTokens = options.maxTokens ?? 512;
    this.batchSize = options.batchSize ?? 8;
    this.charsPerToken = options.charsPerToken ?? 4;
    this.documentPrefix = options.documentPrefix ?? '';
    this.stateManager = options.stateManager ?? null;

    try {
      const hfEnv = env as HFEnv;
      if (hfEnv.onnx) {
        hfEnv.onnx.logLevel = 'error';
        hfEnv.onnx.debug = false;
      }
    } catch (e) {
      logger.debug('[embedder] Failed to set ONNX logLevel:', e);
    }
  }

  private async isModelCached(): Promise<boolean> {
    try {
      const cacheDir = env.cacheDir;
      if (!cacheDir) return false;
      await access(path.join(cacheDir, this.model, 'onnx', 'model.onnx'));
      return true;
    } catch {
      return false;
    }
  }

  async initialize(): Promise<void> {
    if (this.state === 'ready') return;
    if (this.state === 'disposing') {
      throw new Error('Cannot initialize while disposing');
    }
    
    if (this.initializingPromise) {
      return this.initializingPromise;
    }

    this.state = 'initializing';
    this.initializingPromise = this._initializeInternal();

    try {
      await this.initializingPromise;
      // Race check: if dispose() was called during initialization, our state will be 'disposing'
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
      if (this.device === 'webgpu' && this.stateManager) {
        this.gpuLockHeld = await this.stateManager.acquireGpuLock(undefined, 30_000);
        if (!this.gpuLockHeld) {
          logger.warn('[embedder] Failed to acquire GPU init lock within 30s — falling back to CPU');
          this.device = 'cpu';
        } else {
          logger.debug('[embedder] Acquired GPU init lock');
        }
      }

      const cached = await this.isModelCached();
      logger.info(
        `[embedder] Loading model: ${this.model} (${cached ? 'from local cache' : 'downloading from HuggingFace'})...`
      );

      const prevAllowRemote = env.allowRemoteModels;
      if (cached) {
        env.allowRemoteModels = false;
      }

      try {
        const timeoutMs = cached ? 30_000 : this.initializationTimeoutMs;
        const errorMessage = cached
          ? `Model load timed out after ${timeoutMs}ms. The cached model at ${env.cacheDir ?? 'local cache'} may be corrupted.`
          : `Model download timed out after ${timeoutMs}ms. Check network connection or try a smaller model.`;

        const pipelinePromise = Promise.resolve(pipeline('feature-extraction', this.model, {
          device: this.device as 'webgpu' | 'cpu' | 'auto' | 'gpu' | 'wasm' | 'cuda' | 'dml' | 'coreml' | 'webnn' | 'webnn-npu' | 'webnn-gpu' | 'webnn-cpu',
        }));

        pipelinePromise.then((p: DisposablePipeline) => {
          // If state is disposing/idle/failed and the pipeline resolves later,
          // safely dispose it instead of holding it.
          if (this.pipeline !== p && this.state !== 'initializing') {
            logger.warn('[embedder] Disposing orphaned pipeline that resolved late');
            try { p.dispose(); } catch { /* ignore */ }
          }
        }).catch(() => {});

        this.pipeline = await getLogger().runCapturingStderr(async () => {
          return await withTimeout(
            pipelinePromise,
            timeoutMs,
            errorMessage
          );
        });

        logger.info(`[embedder] Pipeline loaded (device: ${this.device})`);
      } catch (loadErr) {
        const errorMsg = loadErr instanceof Error ? loadErr.message : String(loadErr);
        
        // Check if this is a WebGPU validation error during initial loading
        if (this.device === 'webgpu' && this.isWebGpuDeviceError(loadErr)) {
          const isValidationError = errorMsg.toLowerCase().includes('validation');
          
          if (isValidationError) {
            logger.warn('[embedder] WebGPU validation error during pipeline loading (likely buffer binding issue with decoder model) — falling back to CPU');
            logger.debug('[embedder] Validation error details:', errorMsg);
          } else {
            logger.warn('[embedder] WebGPU OOM during pipeline loading — falling back to CPU');
          }
          
          // Clean up and fall back to CPU
          if (this.pipeline) {
            try { await (this.pipeline as DisposablePipeline).dispose(); } catch { /* ignore */ }
          }
          this.pipeline = null;

          if (this.gpuLockHeld && this.stateManager) {
            await this.stateManager.releaseGpuLock().catch(() => {});
            this.gpuLockHeld = false;
          }

          // Load on CPU instead
          this.device = 'cpu';
          logger.info(`[embedder] Retrying model load on CPU after WebGPU ${isValidationError ? 'validation' : 'OOM'} error`);
          
          this.pipeline = await getLogger().runCapturingStderr(async () => {
            return await withTimeout(
              pipeline('feature-extraction', this.model, {
                device: 'cpu',
              }),
              this.initializationTimeoutMs,
              'CPU fallback model load timed out'
            );
          });
          logger.info(`[embedder] Pipeline loaded (device: ${this.device})`);
        } else {
          throw loadErr;
        }
      } finally {
        env.allowRemoteModels = prevAllowRemote;
      }

      let dummy: any;
      try {
        dummy = await withTimeout(
          this.pipeline('warmup', { pooling: this.poolingMode, normalize: false }),
          20_000,
          'Model warmup timed out after 20000ms.'
        );
      } catch (warmupErr) {
        const errorMsg = warmupErr instanceof Error ? warmupErr.message : String(warmupErr);
        
        if (this.device === 'webgpu' && this.isWebGpuDeviceError(warmupErr)) {
          const isValidationError = errorMsg.toLowerCase().includes('validation');
          const isOomError = errorMsg.toLowerCase().includes('out_of_device_memory') || 
                             errorMsg.toLowerCase().includes('vk_error_out_of_device_memory');
          
          if (isValidationError) {
            logger.warn('[embedder] WebGPU validation error during warmup (likely buffer binding issue with decoder model) — falling back to CPU');
            logger.debug('[embedder] Validation error details:', errorMsg);
          } else {
            logger.warn('[embedder] WebGPU OOM during warmup — falling back to CPU');
          }
          
          if (this.pipeline) {
              try { await (this.pipeline as DisposablePipeline).dispose(); } catch { /* ignore */ }
          }
          this.pipeline = null;

          if (this.gpuLockHeld && this.stateManager) {
            await this.stateManager.releaseGpuLock().catch(() => {});
            this.gpuLockHeld = false;
          }

          this.device = 'cpu';
          this.pipeline = await getLogger().runCapturingStderr(async () => {
            return await withTimeout(
              pipeline('feature-extraction', this.model, {
                device: 'cpu',
              }),
              this.initializationTimeoutMs,
              'CPU fallback model load timed out'
            );
          });
          dummy = await withTimeout(
            this.pipeline('warmup', { pooling: this.poolingMode, normalize: false }),
            20_000,
            'CPU warmup timed out after 20000ms.'
          );
          logger.warn(`[embedder] CPU fallback ready after WebGPU warmup ${isValidationError ? 'validation' : 'OOM'} error.`);
        } else {
          throw warmupErr;
        }
      }
      this.dimension = dummy.dims[dummy.dims.length - 1] ?? null;

      if (this.gpuLockHeld && this.stateManager) {
        await this.stateManager.releaseGpuLock().catch(() => {});
        this.gpuLockHeld = false;
      }

      logger.info(`[embedder] Ready. Dimension: ${this.dimension}, device: ${this.device}`);
    } catch (err) {
      if (this.gpuLockHeld && this.stateManager) {
        await this.stateManager.releaseGpuLock().catch(() => {});
        this.gpuLockHeld = false;
      }
      if (this.pipeline) {
        try { await (this.pipeline as DisposablePipeline).dispose(); } catch (_e) { /* ignore */ }
        this.pipeline = null;
      }
      logger.error(`[embedder] Failed to initialize:`, err);
      throw err;
    }
  }

  isInitialized(): boolean {
    return this.state === 'ready' && this.pipeline !== null && this.dimension !== null;
  }

  getDimension(): number {
    if (!this.isInitialized() || this.dimension === null) {
      throw new Error('Embedder not initialized');
    }
    return this.dimension;
  }

  private isWebGpuDeviceError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    const lowerMsg = msg.toLowerCase();
    return (
      lowerMsg.includes('webgpu') ||
      lowerMsg.includes('out_of_device_memory') ||
      lowerMsg.includes('vk_error_out_of_device_memory') ||
      lowerMsg.includes('vkallocatememory') ||
      lowerMsg.includes('device lost') ||
      lowerMsg.includes('devicelost') ||
      lowerMsg.includes('validation failed') ||
      lowerMsg.includes('invalid buffer') ||
      lowerMsg.includes('bindgroup') ||
      lowerMsg.includes('minbindingsize') ||
      msg.includes('past_key_values')
    );
  }

  private async recoverToCpu(): Promise<void> {
    logger.warn('[embedder] WebGPU device error detected — falling back to CPU for this session');
    if (this.gpuLockHeld && this.stateManager) {
      await this.stateManager.releaseGpuLock().catch(() => {});
      this.gpuLockHeld = false;
    }
    this.state = 'initializing';
    if (this.pipeline) {
      try { await (this.pipeline as DisposablePipeline).dispose(); } catch (_e) { /* ignore */ }
      this.pipeline = null;
    }
    this.device = 'cpu';
    
    // Explicit re-init synchronously to ensure state recovers without data races
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
    logger.warn('[embedder] CPU fallback ready.');
  }

  private pipelineOpts(): { pooling: 'mean' | 'cls' | 'last_token'; normalize: boolean } {
    return {
      pooling: this.poolingMode as 'mean' | 'cls' | 'last_token',
      normalize: true,
    };
  }

  private truncateText(text: string): string {
    const maxChars = this.maxTokens * this.charsPerToken;
    return text.length > maxChars ? text.slice(0, maxChars) : text;
  }

  async embed(text: string): Promise<Float32Array> {
    if (!this.isInitialized()) {
      throw new Error('Embedder not initialized');
    }

    const input = this.truncateText(this.queryPrefix ? this.queryPrefix + text : text);
    let lockAcquired = false;
    if (this.device === 'webgpu' && this.stateManager) {
      lockAcquired = await this.stateManager.acquireGpuLock(undefined, 120_000);
      if (!lockAcquired) {
        logger.warn('[embedder] GPU per-call lock timeout after 120s — proceeding without lock');
      }
    }
    try {
      const output = await getLogger().runCapturingStderr(async () => {
        return await this.pipeline!(input, this.pipelineOpts());
      });
      return output.data as Float32Array;
    } catch (err) {
      if (this.isWebGpuDeviceError(err)) {
        if (lockAcquired && this.stateManager) {
          await this.stateManager.releaseGpuLock().catch(() => {});
          lockAcquired = false;
        }
        await this.recoverToCpu();
        const output = await getLogger().runCapturingStderr(async () => {
          return await this.pipeline!(input, this.pipelineOpts());
        });
        return output.data as Float32Array;
      }
      throw err;
    } finally {
      if (lockAcquired && this.stateManager) {
        await this.stateManager.releaseGpuLock().catch(() => {});
      }
    }
  }

  async embedMany(texts: string[]): Promise<Float32Array[]> {
    return metrics.measure('embedMany_latency', async () => {
      if (!this.isInitialized()) {
        throw new Error('Embedder not initialized');
      }

      const dim = this.getDimension();
      const results: Float32Array[] = [];

      let lockAcquired = false;
      if (this.device === 'webgpu' && this.stateManager) {
        // Use a longer timeout for batch operations as they are expected to take longer
        lockAcquired = await this.stateManager.acquireGpuLock(undefined, 300_000);
        if (!lockAcquired) {
          logger.warn('[embedder] GPU batch lock timeout after 300s — proceeding without lock');
        }
      }

      try {
        for (let i = 0; i < texts.length; i += this.batchSize) {
          const batch = texts.slice(i, i + this.batchSize).map(t => {
            const truncated = this.truncateText(t);
            return this.documentPrefix ? this.documentPrefix + truncated : truncated;
          });

          let output: any;
          try {
            output = await getLogger().runCapturingStderr(async () => {
              return await this.pipeline!(batch, this.pipelineOpts());
            });
          } catch (err) {
            if (this.isWebGpuDeviceError(err)) {
              if (lockAcquired && this.stateManager) {
                await this.stateManager.releaseGpuLock().catch(() => {});
                lockAcquired = false;
              }
              await this.recoverToCpu();
              output = await getLogger().runCapturingStderr(async () => {
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
      } finally {
        if (lockAcquired && this.stateManager) {
          await this.stateManager.releaseGpuLock().catch(() => {});
        }
      }

      return results;
    });
  }

  async dispose(): Promise<void> {
    if (this.state === 'idle') return;

    // Handle concurrent dispose requests safely
    if (this.state === 'disposing' && this.disposePromise) {
      return this.disposePromise;
    }

    this.state = 'disposing';
    this.disposePromise = (async () => {
      // If we are currently initializing, we must wait for it to finish or fail
      // so we don't dispose a half-formed session or leave orphaned promises.
      if (this.initializingPromise) {
        try {
          await this.initializingPromise;
        } catch (_e) {
          // Initialize failed, which is fine, we just need it to finish
        }
      }

      if (this.pipeline) {
        try {
          await (this.pipeline as DisposablePipeline).dispose();
        } catch (err) {
          logger.warn('[embedder] Error during pipeline dispose:', err);
        }
        this.pipeline = null;
        this.dimension = null;
      }

      if (this.stateManager) {
        await this.stateManager.releaseGpuLock().catch(() => {});
        this.gpuLockHeld = false;
      }

      this.state = 'idle';
      this.disposePromise = null;
    })();

    return this.disposePromise;
  }
}
