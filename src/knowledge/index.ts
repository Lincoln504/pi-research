import { Embedder } from './embedder.ts';
import { KnowledgeStore } from './store.ts';
import { WriterQueue } from './writer-queue.ts';
import { Chunker } from './chunker.ts';
import { getConfig } from '../config.ts';
import { logger } from '../logger.ts';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EXTENSION_DIR = path.join(__dirname, '..', '..');

interface ModelConfig {
  pooling: 'mean' | 'cls' | 'last_token';
  queryPrefix?: string;
  // Target chunk size in characters. Derived from each model's training context and
  // empirical RAG benchmarks — not just the hard token limit but the retrieval sweet spot.
  chunkSize: number;
  // Overlap fraction (0–0.5). 0.15 is the empirically best single value.
  overlapPct: number;
}

// All-MiniLM-L6-v2: trained at 128 tokens — stay near that distribution (~200 tokens × 4 chars).
// bge-small-en / ml-e5-*: 512-token max, trained at 512 — 375 tokens × 4 chars is a safe sweet spot.
// all-mpnet-base-v2: fine-tuned at 128 tokens, truncates at 384 — 300 tokens × 4 chars.
// bge-m3: 8192-token max, but dense retrieval peaks at 256-512 tokens, same practical sweet spot.
// embeddinggemma-300m: 2048-token max, evaluated at 512 — 450 tokens × 4 chars.
// Qwen3-Embedding-0.6B: 32768-token max, production sweet spot 512-768 tokens — 625 tokens × 4 chars.
const MODEL_CONFIG: Record<string, ModelConfig> = {
  'Xenova/all-MiniLM-L6-v2':             { pooling: 'mean', chunkSize: 800,  overlapPct: 0.15 },
  'Xenova/bge-small-en-v1.5':            { pooling: 'mean', chunkSize: 1500, overlapPct: 0.15 },
  'Xenova/all-mpnet-base-v2':            { pooling: 'mean', chunkSize: 1200, overlapPct: 0.15 },
  'Xenova/multilingual-e5-small':        { pooling: 'mean', chunkSize: 1500, overlapPct: 0.15 },
  'Xenova/multilingual-e5-base':         { pooling: 'mean', chunkSize: 1500, overlapPct: 0.15 },
  'Xenova/bge-m3':                       { pooling: 'cls',  chunkSize: 1500, overlapPct: 0.15 },
  'onnx-community/embeddinggemma-300m-ONNX': { pooling: 'mean', chunkSize: 1800, overlapPct: 0.15 },
  'onnx-community/Qwen3-Embedding-0.6B-ONNX': {
    pooling: 'last_token',
    queryPrefix: 'Instruct: Given a web search query, retrieve relevant passages.\nQuery: ',
    chunkSize: 2500,
    overlapPct: 0.15,
  },
};

const DEFAULT_CHUNK_SIZE = 1200;
const DEFAULT_OVERLAP_PCT = 0.15;

/** Returns embedder configuration (pooling + query prefix) for a model. Pure — safe to call any time. */
export function getModelEmbedderConfig(modelId: string): { pooling: 'mean' | 'cls' | 'last_token'; queryPrefix?: string } {
  const cfg = MODEL_CONFIG[modelId];
  return cfg ? { pooling: cfg.pooling, queryPrefix: cfg.queryPrefix } : { pooling: 'mean' };
}

/** Returns chunk size and overlap fraction for a model. Pure — safe to call any time. */
export function getModelChunkConfig(modelId: string): { chunkSize: number; overlapPct: number } {
  const cfg = MODEL_CONFIG[modelId];
  return cfg ? { chunkSize: cfg.chunkSize, overlapPct: cfg.overlapPct } : { chunkSize: DEFAULT_CHUNK_SIZE, overlapPct: DEFAULT_OVERLAP_PCT };
}

let embedder: Embedder | null = null;
let store: KnowledgeStore | null = null;
let writerQueue: WriterQueue | null = null;
let chunker: Chunker | null = null;

let initializationPromise: Promise<void> | null = null;

const MAX_INIT_RETRIES = 5;
const BASE_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 30000;

export async function initKnowledgeStore(): Promise<void> {
  const config = getConfig();
  if (!config.KNOWLEDGE_STORE_ENABLED) return;
  if (initializationPromise) return initializationPromise;

  initializationPromise = (async () => {
    for (let attempt = 1; attempt <= MAX_INIT_RETRIES; attempt++) {
      try {
        logger.info(`[knowledge] Initializing Knowledge Store (attempt ${attempt}/${MAX_INIT_RETRIES})...`);

        const modelCfg = getModelEmbedderConfig(config.EMBEDDING_MODEL);
        embedder = new Embedder({
          model: config.EMBEDDING_MODEL,
          pooling: modelCfg.pooling,
          queryPrefix: modelCfg.queryPrefix,
        });
        const embedInit = embedder.initialize();

        store = new KnowledgeStore({
          dbDir: path.join(EXTENSION_DIR, 'knowledge_db'),
          embedder: embedder,
          modelName: config.EMBEDDING_MODEL,
        });

        const chunkCfg = getModelChunkConfig(config.EMBEDDING_MODEL);
        chunker = new Chunker({
          targetSize: chunkCfg.chunkSize,
          overlap: Math.round(chunkCfg.chunkSize * chunkCfg.overlapPct),
        });

        writerQueue = new WriterQueue({ store: store, chunker: chunker });

        await embedInit;
        await store.open();

        logger.info('[knowledge] Knowledge Store ready.');
        return;
      } catch (err) {
        // Null all singletons to prevent leaking partially-constructed instances
        embedder = null;
        store = null;
        chunker = null;
        writerQueue = null;

        if (attempt >= MAX_INIT_RETRIES) {
          logger.error(`[knowledge] Initialization failed after ${MAX_INIT_RETRIES} attempts. Giving up.`, err);
          initializationPromise = null;
          throw err;
        }

        const backoffDelay = Math.min(BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1), MAX_RETRY_DELAY_MS);
        const totalDelay = backoffDelay + Math.random() * 500;
        logger.warn(`[knowledge] Attempt ${attempt}/${MAX_INIT_RETRIES} failed. Retrying in ${(totalDelay / 1000).toFixed(1)}s...`, err);
        await new Promise(resolve => setTimeout(resolve, totalDelay));
      }
    }
  })();

  return initializationPromise;
}

export function getEmbedder(): Embedder {
  if (!embedder) throw new Error('Knowledge store not initialized');
  return embedder;
}

export function getStore(): KnowledgeStore {
  if (!store) throw new Error('Knowledge store not initialized');
  return store;
}

export function getWriterQueue(): WriterQueue {
  if (!writerQueue) throw new Error('Knowledge store not initialized');
  return writerQueue;
}

export function isKnowledgeStoreReady(): boolean {
  return embedder !== null && embedder.isInitialized() && store !== null;
}

const DRAIN_TIMEOUT_MS = 30_000;

export async function shutdownKnowledgeStore(): Promise<void> {
  if (!store && !writerQueue) return;

  if (writerQueue) {
    logger.info('[knowledge] Draining writer queue...');
    const timeout = new Promise<void>(resolve => setTimeout(resolve, DRAIN_TIMEOUT_MS));
    await Promise.race([writerQueue.drain(), timeout]);
    logger.info('[knowledge] Writer queue drained.');
  }

  if (store) {
    // Rebuild FTS after all documents have been written so the next session
    // can search newly ingested content via full-text search.
    await store.rebuildFtsIndex();
    await store.close();
    logger.info('[knowledge] Knowledge store closed.');
  }
}
