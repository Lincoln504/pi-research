import { pipeline, env, type FeatureExtractionPipeline } from '@huggingface/transformers';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { logger, getLogger } from '../logger.ts';

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

    // Suppress ONNX Runtime native log spam; real errors surface via try/catch
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
            this.device = 'cpu';
            this.pipeline = await getLogger().runCapturingStderr(async () => {
              return await withTimeout(
                pipeline('feature-extraction', this.model, { device: 'cpu' as any }),
                this.initializationTimeoutMs,
                'CPU fallback model load timed out'
              );
            });
            dummy = await withTimeout(
              this.pipeline('warmup', { pooling: this.poolingMode, normalize: false }),
              20_000,
              'CPU warmup timed out after 20000ms.'
            );
            logger.info('[embedder] CPU fallback ready after WebGPU warmup OOM.');
          } else {
            throw warmupErr;
          }
        }
        this.dimension = dummy.dims[dummy.dims.length - 1] ?? null;

        logger.info(`[embedder] Ready. Dimension: ${this.dimension}, device: ${this.device}`);
      } catch (err) {
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
    const msg = err instanceof Error ? err.message : String(err);
    return (
      msg.includes('WebGPU') ||
      msg.includes('Invalid Buffer') ||
      msg.includes('OUT_OF_DEVICE_MEMORY') ||
      msg.includes('device lost') ||
      msg.includes('DeviceLost')
    );
  }

  // Called when a WebGPU device error is detected mid-session. Disposes the broken
  // pipeline and re-initializes on CPU so the rest of the session stays functional.
  private async recoverToCpu(): Promise<void> {
    logger.warn('[embedder] WebGPU device error detected — falling back to CPU for this session');
    if (this.pipeline) {
      try { await (this.pipeline as any).dispose(); } catch { /* ignore dispose errors during recovery */ }
      this.pipeline = null;
      this.initializing = null;
    }
    this.device = 'cpu';
    await this.initialize();
    logger.info('[embedder] CPU fallback ready.');
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
    try {
      const output = await this.pipeline(input, this.pipelineOpts());
      return output.data as Float32Array;
    } catch (err) {
      if (this.isWebGpuDeviceError(err)) {
        await this.recoverToCpu();
        const output = await this.pipeline!(input, this.pipelineOpts());
        return output.data as Float32Array;
      }
      throw err;
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
      let output: any;
      try {
        output = await this.pipeline(batch, this.pipelineOpts());
      } catch (err) {
        if (this.isWebGpuDeviceError(err)) {
          await this.recoverToCpu();
          output = await this.pipeline!(batch, this.pipelineOpts());
        } else {
          throw err;
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
      this.initializing = null;
    }
  }
}
