import { pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';
import { logger } from '../logger.ts';

export interface EmbedderOptions {
  model: string;
}

export class Embedder {
  private pipeline: FeatureExtractionPipeline | null = null;
  private initializing: Promise<void> | null = null;
  private model: string;
  private dimension: number | null = null;

  constructor(options: EmbedderOptions) {
    this.model = options.model;
  }

  async initialize(): Promise<void> {
    if (this.pipeline) return;
    if (this.initializing) return this.initializing;

    this.initializing = (async () => {
      try {
        logger.info(`[embedder] Initializing model: ${this.model}...`);
        this.pipeline = await pipeline('feature-extraction', this.model, {
          device: 'cpu',
        });
        
        // Warm up and determine dimension
        const dummy = await this.pipeline('warmup');
        this.dimension = dummy.dims[dummy.dims.length - 1];
        
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

    const output = await this.pipeline(text, {
      pooling: 'mean',
      normalize: true,
    });

    return output.data as Float32Array;
  }

  async embedMany(texts: string[]): Promise<Float32Array[]> {
    if (!this.pipeline) {
      throw new Error('Embedder not initialized');
    }

    const output = await this.pipeline(texts, {
      pooling: 'mean',
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
