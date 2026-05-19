import { pipeline, env, type FeatureExtractionPipeline } from '@huggingface/transformers';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../logger.ts';

export interface EmbedderOptions {
  model: string;
  pooling?: 'mean' | 'cls' | 'last_token';
  // Prepended to embed() (query) calls only; embedMany() (document) calls are unprefixed.
  queryPrefix?: string;
  initializationTimeoutMs?: number;
}

/**
 * Wraps a promise with a timeout. Throws an error if the promise doesn't resolve
 * within the specified time.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMessage: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(errorMessage)), timeoutMs)
    ),
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

  constructor(options: EmbedderOptions) {
    this.model = options.model;
    this.poolingMode = options.pooling ?? 'mean';
    this.queryPrefix = options.queryPrefix ?? '';
    this.initializationTimeoutMs = options.initializationTimeoutMs ?? 120000; // Default 2 minutes
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

          this.pipeline = await withTimeout(
            pipeline('feature-extraction', this.model, {
              device: 'cpu',
            }),
            timeoutMs,
            errorMessage
          );
        } finally {
          env.allowRemoteModels = prevAllowRemote;
        }

        // Warm up and determine dimension
        const dummy = await withTimeout(
          this.pipeline('warmup', { pooling: this.poolingMode, normalize: false }),
          20_000,
          'Model warmup timed out after 20000ms.'
        );
        this.dimension = dummy.dims[dummy.dims.length - 1] ?? null;

        logger.info(`[embedder] Ready. Dimension: ${this.dimension}`);
      } catch (err) {
        logger.error(`[embedder] Failed to initialize:`, err);
        this.initializing = null;
        throw err;
      }
    })();

    return this.initializing;
  }

  isInitialized(): boolean {
    return this.pipeline !== null;
  }

  getDimension(): number {
    if (this.dimension === null) {
      throw new Error('Embedder not initialized');
    }
    return this.dimension;
  }

  async embed(text: string): Promise<Float32Array> {
    if (!this.pipeline) {
      throw new Error('Embedder not initialized');
    }

    const input = this.queryPrefix ? this.queryPrefix + text : text;
    const output = await this.pipeline(input, {
      pooling: this.poolingMode,
      normalize: true,
    });

    return output.data as Float32Array;
  }

  async embedMany(texts: string[]): Promise<Float32Array[]> {
    if (!this.pipeline) {
      throw new Error('Embedder not initialized');
    }

    const output = await this.pipeline(texts, {
      pooling: this.poolingMode,
      normalize: true,
    });

    const dim = this.getDimension();
    const results: Float32Array[] = [];

    for (let i = 0; i < texts.length; i++) {
      results.push(output.data.slice(i * dim, (i + 1) * dim) as Float32Array);
    }

    return results;
  }
}
