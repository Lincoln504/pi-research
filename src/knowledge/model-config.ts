/**
 * Embedding Model Configuration
 *
 * Pure lookup table for supported embedding models.
 * Extracted to a standalone module so both knowledge/index.ts and
 * infrastructure/embedding/embedding-factory.ts can import it without
 * creating a circular dependency between those two modules.
 */

interface ModelConfig {
  pooling: 'mean' | 'cls' | 'last_token';
  queryPrefix?: string;
  chunkSize: number;
  overlapPct: number;
  maxTokens?: number;
  batchSize?: number;
  charsPerToken?: number;
  documentPrefix?: string;
  useCache?: boolean;
  multilingual: boolean;
}

const MODEL_CONFIG: Record<string, ModelConfig> = {
  'Xenova/multilingual-e5-small': {
    pooling: 'mean',
    chunkSize: 1500,
    overlapPct: 0.15,
    queryPrefix: 'query: ',
    documentPrefix: 'passage: ',
    charsPerToken: 3.5,
    multilingual: true,
  },
  'Xenova/multilingual-e5-base': {
    pooling: 'mean',
    chunkSize: 1500,
    overlapPct: 0.15,
    queryPrefix: 'query: ',
    documentPrefix: 'passage: ',
    charsPerToken: 3.5,
    multilingual: true,
  },
  'Xenova/bge-m3': {
    pooling: 'cls',
    chunkSize: 1500,
    overlapPct: 0.15,
    charsPerToken: 3.5,
    multilingual: true,
  },
  'onnx-community/embeddinggemma-300m-ONNX': {
    pooling: 'mean',
    chunkSize: 1600,
    overlapPct: 0.15,
    queryPrefix: 'Instruct: Given a web search query, retrieve relevant passages that answer the query.\nQuery: ',
    charsPerToken: 3.5,
    multilingual: true,
  },
  'onnx-community/Qwen3-Embedding-0.6B-ONNX': {
    pooling: 'last_token',
    queryPrefix: 'Instruct: Given a web search query, retrieve relevant passages.\nQuery: ',
    chunkSize: 1200,
    overlapPct: 0.15,
    maxTokens: 512,
    batchSize: 2,
    charsPerToken: 2.5,
    useCache: false,
    multilingual: true,
  },
  'Xenova/all-MiniLM-L6-v2': {
    pooling: 'mean',
    chunkSize: 800,
    overlapPct: 0.15,
    maxTokens: 256,
    multilingual: false,
  },
  'Xenova/bge-small-en-v1.5': {
    pooling: 'cls',
    chunkSize: 1500,
    overlapPct: 0.15,
    multilingual: false,
  },
  'Xenova/all-mpnet-base-v2': {
    pooling: 'mean',
    chunkSize: 1200,
    overlapPct: 0.15,
    maxTokens: 384,
    multilingual: false,
  },
  'onnx-community/granite-embedding-small-english-r2-ONNX': {
    pooling: 'cls',
    chunkSize: 1800,
    overlapPct: 0.15,
    maxTokens: 512,
    batchSize: 8,
    multilingual: false,
  },
};

export const SUPPORTED_MODELS: ReadonlyArray<{ id: string; multilingual: boolean }> =
  Object.entries(MODEL_CONFIG).map(([id, cfg]) => ({ id, multilingual: cfg.multilingual }));

const DEFAULT_CHUNK_SIZE = 1200;
const DEFAULT_OVERLAP_PCT = 0.15;

export function getModelEmbedderConfig(modelId: string): {
  pooling: 'mean' | 'cls' | 'last_token';
  queryPrefix?: string;
  documentPrefix?: string;
  maxTokens?: number;
  batchSize?: number;
  charsPerToken?: number;
  useCache?: boolean;
} {
  const cfg = MODEL_CONFIG[modelId];
  return cfg
    ? {
        pooling: cfg.pooling,
        queryPrefix: cfg.queryPrefix,
        documentPrefix: cfg.documentPrefix,
        maxTokens: cfg.maxTokens,
        batchSize: cfg.batchSize,
        charsPerToken: cfg.charsPerToken,
        useCache: cfg.useCache,
      }
    : { pooling: 'mean' };
}

export function getModelChunkConfig(modelId: string): { chunkSize: number; overlapPct: number } {
  const cfg = MODEL_CONFIG[modelId];
  return cfg
    ? { chunkSize: cfg.chunkSize, overlapPct: cfg.overlapPct }
    : { chunkSize: DEFAULT_CHUNK_SIZE, overlapPct: DEFAULT_OVERLAP_PCT };
}
