import { Embedder } from './embedder.ts';
import { KnowledgeStore } from './store.ts';
import { WriterQueue } from './writer-queue.ts';
import { Chunker } from './chunker.ts';
import { getConfig, validateConfig, getDbDir } from '../config.ts';
import { logger } from '../logger.ts';
import { getService } from '../core/service-registry.ts';
import { ServiceNames } from '../core/service-interfaces.ts';
import type { IStateManager } from '../core/service-interfaces.ts';
import * as fs from 'node:fs';
import type { MigrationStrategy } from './migration.ts';

/** Migration strategy for model changes (read from env or config) */
function getMigrationStrategy(): MigrationStrategy | undefined {
  const strategy = process.env['PI_KNOWLEDGE_STORE_MIGRATION_STRATEGY'];
  if (!strategy) return undefined;
  
  // Only support 'drop' and 're-embed' - simplified from 4 strategies
  const validStrategies: MigrationStrategy[] = ['drop', 're-embed'];
  if (validStrategies.includes(strategy as MigrationStrategy)) {
    return strategy as MigrationStrategy;
  }
  
  logger.warn(`[knowledge] Invalid migration strategy '${strategy}'. Valid options: drop, re-embed. Falling back to default (drop).`);
  return undefined;
}

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

export function getModelEmbedderConfig(modelId: string): { pooling: 'mean' | 'cls' | 'last_token'; queryPrefix?: string; documentPrefix?: string; maxTokens?: number; batchSize?: number; charsPerToken?: number; useCache?: boolean } {
  const cfg = MODEL_CONFIG[modelId];
  return cfg
    ? { pooling: cfg.pooling, queryPrefix: cfg.queryPrefix, documentPrefix: cfg.documentPrefix, maxTokens: cfg.maxTokens, batchSize: cfg.batchSize, charsPerToken: cfg.charsPerToken, useCache: cfg.useCache }
    : { pooling: 'mean' };
}

export function getModelChunkConfig(modelId: string): { chunkSize: number; overlapPct: number } {
  const cfg = MODEL_CONFIG[modelId];
  return cfg ? { chunkSize: cfg.chunkSize, overlapPct: cfg.overlapPct } : { chunkSize: DEFAULT_CHUNK_SIZE, overlapPct: DEFAULT_OVERLAP_PCT };
}

/**
 * Result of knowledge store initialization
 */
export interface KnowledgeStoreComponents {
  embedder: Embedder;
  store: KnowledgeStore;
  writerQueue: WriterQueue;
}

// Tracks the embedder instance that currently has an in-flight pipeline load.
let inflightEmbedder: Embedder | null = null;

const MAX_INIT_RETRIES = 5;
const BASE_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 30000;

/**
 * Initialize knowledge store components.
 * This is a factory function used by KnowledgeStoreService.
 */
export async function createKnowledgeStoreComponents(): Promise<KnowledgeStoreComponents> {
  const config = getConfig();
  if (!config.KNOWLEDGE_STORE_ENABLED) {
    throw new Error('Knowledge store is disabled in configuration');
  }
  validateConfig(config);

  for (let attempt = 1; attempt <= MAX_INIT_RETRIES; attempt++) {
    try {
      logger.info(`[knowledge] Creating Knowledge Store components (attempt ${attempt}/${MAX_INIT_RETRIES})...`);

      const modelCfg = getModelEmbedderConfig(config.EMBEDDING_MODEL);
      
      let embedder: Embedder;
      if (inflightEmbedder !== null) {
        embedder = inflightEmbedder;
      } else {
        embedder = new Embedder({
          model: config.EMBEDDING_MODEL,
          pooling: modelCfg.pooling,
          queryPrefix: modelCfg.queryPrefix,
          initializationTimeoutMs: config.EMBEDDING_MODEL_INIT_TIMEOUT_MS,
          device: config.EMBEDDING_DEVICE,
          maxTokens: modelCfg.maxTokens,
          batchSize: modelCfg.batchSize,
          charsPerToken: modelCfg.charsPerToken,
          documentPrefix: modelCfg.documentPrefix,
          stateManager: await getService<IStateManager>(ServiceNames.STATE_MANAGER),
        });
        inflightEmbedder = embedder;
      }

      const migrationStrategy = getMigrationStrategy();
      const store = new KnowledgeStore({
        dbDir: getDbDir(),
        embedder: embedder,
        modelName: config.EMBEDDING_MODEL,
        migrationStrategy: migrationStrategy,
      });

      const chunkCfg = getModelChunkConfig(config.EMBEDDING_MODEL);
      const chunkOverlap = Math.round(chunkCfg.chunkSize * chunkCfg.overlapPct);
      const chunker = new Chunker({ targetSize: chunkCfg.chunkSize, overlap: chunkOverlap });
      const writerQueue = new WriterQueue({ store: store, chunker });

      await store.open();
      
      inflightEmbedder = null;
      return { embedder, store, writerQueue };
    } catch (err) {
      const givingUp = attempt === MAX_INIT_RETRIES;
      if (givingUp) {
        throw err;
      }
      const backoffDelay = Math.min(BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1), MAX_RETRY_DELAY_MS);
      const totalDelay = backoffDelay + Math.random() * 500;
      logger.warn(`[knowledge] Attempt ${attempt}/${MAX_INIT_RETRIES} failed. Retrying in ${(totalDelay / 1000).toFixed(1)}s...`, err);
      await new Promise(resolve => setTimeout(resolve, totalDelay));
    }
  }
  
  throw new Error('Failed to create knowledge store components');
}

export async function clearKnowledgeStore(): Promise<void> {
  const dbDir = getDbDir();
  if (fs.existsSync(dbDir)) {
    try {
      fs.rmSync(dbDir, { recursive: true, force: true });
      logger.info('[knowledge] Knowledge store cleared via filesystem deletion.');
    } catch (err) {
      logger.error('[knowledge] Failed to delete knowledge_db directory:', err);
      throw err;
    }
  }
}
