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

// Per-model pooling and query-prefix overrides.
// Mean pooling is assumed for any model not listed here.
// BGE-M3: trained with CLS pooling (not mean).
// Qwen3-Embedding: decoder-based, requires last-token pooling + instruction prefix for queries.
const MODEL_CONFIG: Record<string, { pooling: 'mean' | 'cls' | 'last_token'; queryPrefix?: string }> = {
  'Xenova/bge-m3': { pooling: 'cls' },
  'onnx-community/Qwen3-Embedding-0.6B-ONNX': {
    pooling: 'last_token',
    queryPrefix: 'Instruct: Given a web search query, retrieve relevant passages.\nQuery: ',
  },
};

/** Returns the embedder configuration for a given model ID. Pure — safe to call any time. */
export function getModelEmbedderConfig(modelId: string): { pooling: 'mean' | 'cls' | 'last_token'; queryPrefix?: string } {
  return MODEL_CONFIG[modelId] ?? { pooling: 'mean' };
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

        chunker = new Chunker({
          targetSize: config.CHUNK_SIZE_CHARS,
          overlap: config.CHUNK_OVERLAP_CHARS,
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
