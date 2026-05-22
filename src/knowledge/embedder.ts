import { pipeline, env, type FeatureExtractionPipeline } from '@huggingface/transformers';
import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import * as os from 'node:os';
import { logger, getLogger } from '../logger.ts';
import type { StateManager } from '../infrastructure/state-manager.ts';

export interface EmbedderOptions {
  model: string;
  pooling?: 'mean' | 'cls' | 'last_token';
  // Prepended to embed() (query) calls only; embedMany() (document) calls are unprefixed.
  queryPrefix?: string;
  initializationTimeoutMs?: number;
  device?: string;
  // Maximum tokens per sequence. Sequences longer than this are truncated.
  // Limits peak VRAM: a 0.6B decoder model at maxTokens=512 needs ~250MB of inference
  // tensors vs ~4GB at 1042 tokens, making WebGPU inference feasible on 6GB cards.
  maxTokens?: number;
  // Maximum sequences per pipeline call. Larger batches multiply tensor peak proportionally.
  batchSize?: number;
  // Characters per token for pre-truncation estimate. BERT/WordPiece encoder models: ~4.
  // Decoder models with SentencePiece/tiktoken (Qwen3, Gemma): ~2-2.5. Default: 4.
  charsPerToken?: number;
  // Prepended to embedMany() (document) calls only. Used for asymmetric retrieval models
  // (e.g. E5 "passage: " prefix). embedMany() without this set passes text through unchanged.
  documentPrefix?: string;
  stateManager?: StateManager;
}

/**
 * Wraps a promise with a timeout. Throws an error if the promise doesn't resolve
 * within the specified time.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMessage: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
      timer.unref(); // Allow clean exit if this is the only timer keeping the event loop alive
    }),
  ]);
}

/**
 * Returns the directory where transformers.js caches ONNX model files.
 * Follows XDG Base Directory spec: $XDG_CACHE_HOME/pi-research/models
 * or ~/.cache/pi-research/models when XDG_CACHE_HOME is unset.
 * Exported so callers (index.ts TUI, download script, tests) use the same path.
 */
export function getModelCacheDir(): string {
  const xdgCache = process.env['XDG_CACHE_HOME'];
  const base = xdgCache ?? path.join(os.homedir(), '.cache');
  return path.join(base, 'pi-research', 'models');
}

// Redirect transformers.js model cache to a persistent user-global directory so
// models survive npm install/update. Must run at module-load time, before pipeline().
env.cacheDir = getModelCacheDir();

// Suppress ORT C++ native WARNING-level messages (e.g. the Dawn WebGPU
// "maxDynamicStorageBuffersPerPipelineLayout artificially reduced" warning) that write
// directly to FD2 via libonnxruntime.so, completely bypassing JS-level stderr patches.
// onnxruntime-node's initOrtOnce() reads env.logLevel from onnxruntime-common exactly
// once on first session creation; must be set here, at module load, before any session.
// Setting 'error' (ORT level 3) suppresses WARNING (level 2) and below; ERROR/FATAL
// still surface. Session-level logSeverityLevel is already 3 but only covers the
// per-session logger, not the global env logger that the WebGPU EP device init uses.
// onnxruntime-node is CJS, so we must use createRequire to get the same CJS instance
// (ESM import would produce a separate instance that onnxruntime-node would not see).
try {
  const _nodeRequire = createRequire(import.meta.url);
  const { env: ortEnv } = _nodeRequire('onnxruntime-common') as { env: { logLevel?: string } };
  if (ortEnv) ortEnv.logLevel = 'error';
} catch { /* onnxruntime-common not resolvable — skip */ }

export class Embedder {
  private pipeline: FeatureExtractionPipeline | null = null;
  private initializing: Promise<void> | null = null;
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
  // True only while the GPU initialization lock is held (cleared once init completes).
  // Per-batch inference locks use local variables in embed()/embedMany().
  private gpuLockHeld = false;

  constructor(options: EmbedderOptions) {
    this.model = options.model;
    this.poolingMode = options.pooling ?? 'mean';
    this.queryPrefix = options.queryPrefix ?? '';
    this.initializationTimeoutMs = options.initializationTimeoutMs ?? 120000; // Default 2 minutes
    this.device = options.device ?? 'webgpu';
    this.maxTokens = options.maxTokens ?? 512;
    this.batchSize = options.batchSize ?? 8;
    this.charsPerToken = options.charsPerToken ?? 4;
    this.documentPrefix = options.documentPrefix ?? '';
    this.stateManager = options.stateManager ?? null;

    // Suppress ONNX Runtime native log spam (WASM path); real errors surface via try/catch
    try {
      const onnxEnv = (env as any).onnx;
      if (onnxEnv) {
        onnxEnv.logLevel = 'error';
        onnxEnv.debug = false;
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
    if (this.pipeline) return;
    if (this.initializing) return this.initializing;

    this.initializing = (async () => {
      try {
        if (this.device === 'webgpu' && this.stateManager) {
          // Serialize model loading across processes so two processes don't try
          // to allocate GPU memory simultaneously (VK_ERROR_OUT_OF_DEVICE_MEMORY).
          // Lock is released once the model is loaded; per-batch inference locks
          // in embed()/embedMany() handle FCFS scheduling of GPU compute calls.
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

          this.pipeline = await getLogger().runCapturingStderr(async () => {
            return await withTimeout(
              pipeline('feature-extraction', this.model, {
                device: (this.device as any),
              }),
              timeoutMs,
              errorMessage
            );
          });

          logger.info(`[embedder] Pipeline loaded (device: ${this.device})`);
        } finally {
          env.allowRemoteModels = prevAllowRemote;
        }

        // Warm up and determine dimension. If WebGPU OOM fires here (rare but
        // possible when the single warm-up token triggers a large allocation),
        // fall back to CPU immediately rather than deferring to first embed() call.
        let dummy: any;
        try {
          dummy = await withTimeout(
            this.pipeline('warmup', { pooling: this.poolingMode, normalize: false }),
            20_000,
            'Model warmup timed out after 20000ms.'
          );
        } catch (warmupErr) {
          if (this.device === 'webgpu' && this.isWebGpuDeviceError(warmupErr)) {
            logger.warn('[embedder] WebGPU OOM during warmup — falling back to CPU');
            try { await (this.pipeline as any).dispose(); } catch { /* ignore */ }
            this.pipeline = null;

            if (this.gpuLockHeld && this.stateManager) {
              await this.stateManager.releaseGpuLock().catch(() => {});
              this.gpuLockHeld = false;
            }

            this.device = 'cpu';
            this.pipeline = await getLogger().runCapturingStderr(async () => {
              return await withTimeout(
                pipeline('feature-extraction', this.model, {
                  device: 'cpu' as any,
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
            logger.warn('[embedder] CPU fallback ready after WebGPU warmup OOM.');
          } else {
            throw warmupErr;
          }
        }
        this.dimension = dummy.dims[dummy.dims.length - 1] ?? null;

        // Release init lock — per-batch inference locks take over from here.
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
        logger.error(`[embedder] Failed to initialize:`, err);
        this.initializing = null;
        throw err;
      }
    })();

    return this.initializing;
  }

  isInitialized(): boolean {
    return this.pipeline !== null && this.dimension !== null;
  }

  getDimension(): number {
    if (this.dimension === null) {
      throw new Error('Embedder not initialized');
    }
    return this.dimension;
  }

  // Returns true for errors caused by a lost/OOM WebGPU device.
  // After a device loss every subsequent ORT call fails with "Invalid Buffer" — these
  // are all symptoms of the same root cause and should trigger a CPU fallback.
  private isWebGpuDeviceError(err: unknown): boolean {
    const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
    return (
      msg.includes('webgpu') ||
      msg.includes('out_of_device_memory') ||
      msg.includes('vk_error_out_of_device_memory') ||
      msg.includes('vkallocatememory') ||
      msg.includes('device lost') ||
      msg.includes('devicelost')
    );
  }

  // Called when a WebGPU device error is detected mid-session. Disposes the broken
  // pipeline and re-initializes on CPU so the rest of the session stays functional.
  private async recoverToCpu(): Promise<void> {
    logger.warn('[embedder] WebGPU device error detected — falling back to CPU for this session');
    // Release GPU init lock if somehow still held (defensive — should be false post-init).
    if (this.gpuLockHeld && this.stateManager) {
      await this.stateManager.releaseGpuLock().catch(() => {});
      this.gpuLockHeld = false;
    }
    if (this.pipeline) {
      try { await (this.pipeline as any).dispose(); } catch { /* ignore dispose errors during recovery */ }
      this.pipeline = null;
      this.initializing = null;
    }
    this.device = 'cpu';
    await this.initialize();
    logger.warn('[embedder] CPU fallback ready.');
  }

  private pipelineOpts() {
    return {
      pooling: this.poolingMode,
      normalize: true,
    } as any;
  }

  // HF Transformers.js v4.x FeatureExtractionPipeline ignores truncation/max_length options —
  // they are not forwarded to the tokenizer. Pre-truncate by character count instead.
  // charsPerToken is model-specific: ~4 for BERT/WordPiece encoders, ~2 for decoder models
  // (Qwen3 SentencePiece tokenizes at ~2.7 chars/token in practice).
  private truncateText(text: string): string {
    const maxChars = this.maxTokens * this.charsPerToken;
    return text.length > maxChars ? text.slice(0, maxChars) : text;
  }

  async embed(text: string): Promise<Float32Array> {
    if (!this.pipeline) {
      throw new Error('Embedder not initialized');
    }

    const input = this.truncateText(this.queryPrefix ? this.queryPrefix + text : text);
    let lockAcquired = false;
    if (this.device === 'webgpu' && this.stateManager) {
      // Acquire per-call GPU lock to serialize inference across concurrent processes (FCFS).
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
    if (!this.pipeline) {
      throw new Error('Embedder not initialized');
    }

    const dim = this.getDimension();
    const results: Float32Array[] = [];

    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize).map(t => {
        const truncated = this.truncateText(t);
        return this.documentPrefix ? this.documentPrefix + truncated : truncated;
      });

      // Acquire per-batch GPU lock to serialize inference across concurrent processes (FCFS).
      let lockAcquired = false;
      if (this.device === 'webgpu' && this.stateManager) {
        lockAcquired = await this.stateManager.acquireGpuLock(undefined, 120_000);
        if (!lockAcquired) {
          logger.warn('[embedder] GPU per-batch lock timeout after 120s — proceeding without lock');
        }
      }

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
      } finally {
        if (lockAcquired && this.stateManager) {
          await this.stateManager.releaseGpuLock().catch(() => {});
        }
      }

      for (let j = 0; j < batch.length; j++) {
        results.push(output.data.slice(j * dim, (j + 1) * dim) as Float32Array);
      }
    }

    return results;
  }

  // Releases the underlying ORT sessions before process exit. Without this,
  // ORT's C++ destructors run after LoggingManager is torn down → DefaultLogger crash.
  async dispose(): Promise<void> {
    if (this.pipeline) {
      try {
        await (this.pipeline as any).dispose();
      } catch (err) {
        logger.warn('[embedder] Error during pipeline dispose:', err);
      }
      this.pipeline = null;
      this.dimension = null;
      this.initializing = null;
    }

    // Release any held GPU lock (init lock or per-batch lock held at shutdown time).
    if (this.stateManager) {
      await this.stateManager.releaseGpuLock().catch(() => {});
      this.gpuLockHeld = false;
    }
  }
}
