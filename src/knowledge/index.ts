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

let embedder: Embedder | null = null;
let store: KnowledgeStore | null = null;
let writerQueue: WriterQueue | null = null;
let chunker: Chunker | null = null;

let initializationPromise: Promise<void> | null = null;

export async function initKnowledgeStore(): Promise<void> {
  const config = getConfig();
  if (!config.KNOWLEDGE_STORE_ENABLED) return;
  if (initializationPromise) return initializationPromise;

  initializationPromise = (async () => {
    try {
      logger.info('[knowledge] Initializing Knowledge Store...');
      
      embedder = new Embedder({
        model: config.EMBEDDING_MODEL,
      });

      // Embedder initialization might take time (downloading model)
      // We don't await it here to avoid blocking extension activation,
      // but we MUST await it before store.open().
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

      writerQueue = new WriterQueue({
        store: store,
        chunker: chunker,
      });

      await embedInit;
      await store.open();
      
      logger.info('[knowledge] Knowledge Store ready.');
    } catch (err) {
      logger.error('[knowledge] Failed to initialize Knowledge Store:', err);
      initializationPromise = null;
      throw err;
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

export async function shutdownKnowledgeStore(): Promise<void> {
  if (writerQueue) {
    logger.info('[knowledge] Draining writer queue...');
    await writerQueue.drain();
  }
  if (store) {
    await store.close();
  }
}
