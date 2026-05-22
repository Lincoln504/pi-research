import { Embedder } from './embedder.ts';
import { KnowledgeStore } from './store.ts';
import { WriterQueue } from './writer-queue.ts';
import { Chunker } from './chunker.ts';
import { getConfig, validateConfig, getDbDir } from '../config.ts';
import { logger } from '../logger.ts';
import { getSharedStateManager } from '../infrastructure/state-manager.ts';
import * as fs from 'node:fs';

interface ModelConfig {
  pooling: 'mean' | 'cls' | 'last_token';
  queryPrefix?: string;
  // Target chunk size in characters. Derived from each model's training context and
  // empirical RAG benchmarks — not just the hard token limit but the retrieval sweet spot.
  chunkSize: number;
  // Overlap fraction (0–0.5). 0.15 is the empirically best single value.
  overlapPct: number;
  // Maximum tokens passed to the ONNX session per sequence. Truncation is applied if
  // the tokenized length exceeds this. Lower values dramatically reduce VRAM usage for
  // decoder models: 512 tokens vs 1042 tokens is 4x less attention tensor memory.
  maxTokens?: number;
  // Sequences per pipeline call. Decoder models scale quadratically with batch×seq_len,
  // so batchSize=1 is safest on 6GB cards when using Qwen3-0.6B-ONNX.
  batchSize?: number;
  // Characters per token for pre-truncation. BERT/WordPiece encoder models: ~4.
  // XLM-RoBERTa SentencePiece / Gemma SentencePiece: ~3.5. Qwen2 tiktoken: ~2.5. Default: 4.
  charsPerToken?: number;
  // Prefix prepended to document embeddings (embedMany). For asymmetric models like E5
  // that require "passage: " on the document side. Omit for symmetric models.
  documentPrefix?: string;
  // true = supports 100+ languages; false = English-only. Required so new entries are explicit.
  multilingual: boolean;
}

// charsPerToken per tokenizer family (chars/token on typical web content):
//   BERT WordPiece (MiniLM, MPNet)      : ~4.0 — English-optimized vocab, safe floor
//   RoBERTa BPE (bge-small)             : ~4.0 — similar to BERT on English
//   XLM-RoBERTa SentencePiece (E5, BGE-M3): ~3.5 — multilingual vocab, lower English density
//   Gemma SentencePiece (embeddinggemma): ~3.5 — large vocab but SentencePiece BPE
//   Qwen2 tiktoken (Qwen3-Embedding)    : ~2.5 — measured at 2.68 chars/tok on web content
//   BPE 50k vocab (IBM Granite ModernBERT): ~4.0 — English-only BPE, similar density to BERT
//
// Rule: chunkSize must be ≤ maxTokens * charsPerToken (= maxChars) so the full chunk is embedded.
// Ordering: multilingual models first, then English-only. This order is reflected in the TUI.
const MODEL_CONFIG: Record<string, ModelConfig> = {
  // ── Multilingual ─────────────────────────────────────────────────────────────
  // multilingual-e5-*: asymmetric — requires "query: " / "passage: " prefixes.
  // Without them, query and doc vectors land in different sub-spaces → retrieval collapse.
  // XLM-RoBERTa SentencePiece, charsPerToken=3.5. maxChars = 512*3.5 = 1792. chunkSize 1500 ≤ 1792 ✓
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
  // bge-m3: symmetric dense retrieval (no prefix), CLS pooling, 8192-tok max.
  // XLM-RoBERTa SentencePiece, charsPerToken=3.5. maxChars = 512*3.5 = 1792. chunkSize 1500 ≤ 1792 ✓
  'Xenova/bge-m3': {
    pooling: 'cls',
    chunkSize: 1500,
    overlapPct: 0.15,
    charsPerToken: 3.5,
    multilingual: true,
  },
  // embeddinggemma-300m: Gemma SentencePiece, mean pooling. charsPerToken=3.5.
  // Requires specific task prefixes for queries and titles/none for documents.
  // maxChars = 512*3.5 = 1792. chunkSize 1600 ≤ 1792 ✓
  'onnx-community/embeddinggemma-300m-ONNX': {
    pooling: 'mean',
    queryPrefix: 'task: search result | query: ',
    documentPrefix: 'title: none | text: ',
    chunkSize: 1600,
    overlapPct: 0.15,
    charsPerToken: 3.5,
    multilingual: true,
  },
  // Qwen3-Embedding-0.6B: decoder model (last_token pooling), asymmetric instruction prefix.
  // Qwen2 tiktoken measures ~2.68 chars/tok on web content — use 2.5 for headroom.
  // maxChars = 512*2.5 = 1280. chunkSize 1200 ≤ 1280 ✓  (was 2500 → only 40% embedded — fixed)
  // O(seq²) attention: batchSize=2 keeps VRAM at ~500MB overhead on 6GB cards.
  'onnx-community/Qwen3-Embedding-0.6B-ONNX': {
    pooling: 'last_token',
    queryPrefix: 'Instruct: Given a web search query, retrieve relevant passages.\nQuery: ',
    chunkSize: 1200,
    overlapPct: 0.15,
    maxTokens: 512,
    batchSize: 2,
    charsPerToken: 2.5,
    multilingual: true,
  },
  // ── English-only ─────────────────────────────────────────────────────────────
  // all-MiniLM-L6-v2: trained at 256 tokens, 384-dim. chunkSize 800 = 200 tok ≤ 256 ✓
  'Xenova/all-MiniLM-L6-v2': {
    pooling: 'mean',
    chunkSize: 800,
    overlapPct: 0.15,
    maxTokens: 256,  // hard training window; prevent position OOB on long queries
    multilingual: false,
  },
  // bge-small-en-v1.5: CLS pooling (not mean — BGE uses CLS for dense retrieval). 512-tok max.
  // chunkSize 1500 = 375 tok ≤ 512 ✓
  'Xenova/bge-small-en-v1.5': {
    pooling: 'cls',
    chunkSize: 1500,
    overlapPct: 0.15,
    multilingual: false,
  },
  // all-mpnet-base-v2: mean pooling, fine-tuned at 384 tokens. chunkSize 1200 = 300 tok ≤ 384 ✓
  'Xenova/all-mpnet-base-v2': {
    pooling: 'mean',
    chunkSize: 1200,
    overlapPct: 0.15,
    maxTokens: 384,
    multilingual: false,
  },
  // IBM Granite small-english-r2: ModernBERT-based, 47M params, 384-dim, 8192-tok max.
  // BPE (vocab 50k, English-only), CLS pooling, symmetric (no prefix). MTEB-v2: 61.1.
  // maxChars = 512*4 = 2048. chunkSize 1800 ≤ 2048 ✓
  'onnx-community/granite-embedding-small-english-r2-ONNX': {
    pooling: 'cls',
    chunkSize: 1800,
    overlapPct: 0.15,
    maxTokens: 512,
    batchSize: 8,
    multilingual: false,
  },
};

/** Ordered list of all supported embedding models, derived directly from MODEL_CONFIG. */
export const SUPPORTED_MODELS: ReadonlyArray<{ id: string; multilingual: boolean }> =
  Object.entries(MODEL_CONFIG).map(([id, cfg]) => ({ id, multilingual: cfg.multilingual }));

const DEFAULT_CHUNK_SIZE = 1200;
const DEFAULT_OVERLAP_PCT = 0.15;

/** Returns embedder configuration for a model. Pure — safe to call any time. */
export function getModelEmbedderConfig(modelId: string): { pooling: 'mean' | 'cls' | 'last_token'; queryPrefix?: string; documentPrefix?: string; maxTokens?: number; batchSize?: number; charsPerToken?: number } {
  const cfg = MODEL_CONFIG[modelId];
  return cfg
    ? { pooling: cfg.pooling, queryPrefix: cfg.queryPrefix, documentPrefix: cfg.documentPrefix, maxTokens: cfg.maxTokens, batchSize: cfg.batchSize, charsPerToken: cfg.charsPerToken }
    : { pooling: 'mean' };
}

/** Returns chunk size and overlap fraction for a model. Pure — safe to call any time. */
export function getModelChunkConfig(modelId: string): { chunkSize: number; overlapPct: number } {
  const cfg = MODEL_CONFIG[modelId];
  return cfg ? { chunkSize: cfg.chunkSize, overlapPct: cfg.overlapPct } : { chunkSize: DEFAULT_CHUNK_SIZE, overlapPct: DEFAULT_OVERLAP_PCT };
}

let embedder: Embedder | null = null;
let store: KnowledgeStore | null = null;
let writerQueue: WriterQueue | null = null;

let initializationPromise: Promise<void> | null = null;
// Set to true after all retries are exhausted so subsequent calls fail fast
// without spawning new concurrent init attempts.
let initializationPermanentlyFailed = false;

// Tracks the embedder instance that currently has an in-flight pipeline load.
// Prevents concurrent pipeline() calls when retries create new Embedder instances
// while the previous one's orphaned pipeline() is still running.
let inflightEmbedder: Embedder | null = null;

const MAX_INIT_RETRIES = 5;
const BASE_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 30000;

export async function initKnowledgeStore(): Promise<void> {
  const config = getConfig();
  if (!config.KNOWLEDGE_STORE_ENABLED) return;
  validateConfig(config);
  if (initializationPermanentlyFailed) throw new Error('Knowledge store initialization previously failed permanently after all retries');
  if (initializationPromise) return initializationPromise;

  initializationPromise = (async () => {
    for (let attempt = 1; attempt <= MAX_INIT_RETRIES; attempt++) {
      try {
        logger.info(`[knowledge] Initializing Knowledge Store (attempt ${attempt}/${MAX_INIT_RETRIES})...`);

        const modelCfg = getModelEmbedderConfig(config.EMBEDDING_MODEL);

        // Reuse the in-flight embedder if a previous pipeline() load is still running
        // (orphaned by a withTimeout race). This prevents concurrent pipeline() calls.
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
            stateManager: getSharedStateManager(),
          });
          inflightEmbedder = embedder;
        }
        const embedInit = embedder.initialize();

        store = new KnowledgeStore({
          dbDir: getDbDir(),
          embedder: embedder,
          modelName: config.EMBEDDING_MODEL,
        });

        const chunkCfg = getModelChunkConfig(config.EMBEDDING_MODEL);
        const chunkOverlap = Math.round(chunkCfg.chunkSize * chunkCfg.overlapPct);
        const chunker = new Chunker({ targetSize: chunkCfg.chunkSize, overlap: chunkOverlap });
        writerQueue = new WriterQueue({ store: store, chunker });

        await embedInit;
        await store.open();

        inflightEmbedder = null;
        logger.info('[knowledge] Knowledge Store ready.');
        return;
      } catch (err) {
        // Null all singletons to prevent leaking partially-constructed instances.
        // Clear inflightEmbedder only if the embedder's pipeline load has already
        // settled (error path in initialize() nulls this.initializing), so the next
        // retry can start a fresh load rather than re-awaiting a failed promise.
        if (inflightEmbedder !== null && inflightEmbedder.isInitialized() === false) {
          inflightEmbedder = null;
        }
        embedder = null;
        store = null;
        writerQueue = null;

        if (attempt >= MAX_INIT_RETRIES) {
          logger.error(`[knowledge] Initialization failed after ${MAX_INIT_RETRIES} attempts. Giving up.`, err);
          inflightEmbedder = null;
          initializationPermanentlyFailed = true;
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

export async function getEmbedder(): Promise<Embedder> {
  await initKnowledgeStore();
  if (!embedder) throw new Error('Knowledge store not enabled or failed to initialize');
  return embedder;
}

export async function getStore(): Promise<KnowledgeStore> {
  await initKnowledgeStore();
  if (!store) throw new Error('Knowledge store not enabled or failed to initialize');
  return store;
}

export async function getWriterQueue(): Promise<WriterQueue> {
  await initKnowledgeStore();
  if (!writerQueue) throw new Error('Knowledge store not enabled or failed to initialize');
  return writerQueue;
}

export async function clearKnowledgeStore(): Promise<void> {
  const dbDir = getDbDir();
  
  if (store) {
    try {
      await store.clear();
      return;
    } catch (err) {
      logger.warn('[knowledge] Failed to clear store via active connection, falling back to FS deletion:', err);
      await shutdownKnowledgeStore();
    }
  }

  // Fallback to direct FS deletion if no active store or clear() failed
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

export function isKnowledgeStoreReady(): boolean {
  return embedder !== null && embedder.isInitialized() && store !== null;
}

const DRAIN_TIMEOUT_MS = 30_000;

export async function shutdownKnowledgeStore(): Promise<void> {
  if (!store && !writerQueue && !embedder) return;

  if (writerQueue) {
    logger.info('[knowledge] Draining writer queue...');
    const start = Date.now();
    const timeout = new Promise<void>((_resolve, reject) => {
      const timer = setTimeout(() => {
        const elapsed = Date.now() - start;
        logger.warn(`[knowledge] Writer queue drain timed out after ${elapsed}ms`);
        reject(new Error(`Writer queue drain timeout after ${elapsed}ms`));
      }, DRAIN_TIMEOUT_MS);
      timer.unref(); // Allow exit if this is the only timer
    });
    
    try {
      await Promise.race([writerQueue.drain(), timeout]);
      const elapsed = Date.now() - start;
      logger.info(`[knowledge] Writer queue drained in ${elapsed}ms.`);
    } catch (err) {
      logger.warn('[knowledge] Writer queue drain did not complete:', err);
    } finally {
      writerQueue = null;
    }
  }

  if (store) {
    // Rebuild FTS after all documents have been written so the next session
    // can search newly ingested content via full-text search.
    await store.rebuildFtsIndex();
    await store.close();
    logger.info('[knowledge] Knowledge store closed.');
    store = null;
  }

  // Must dispose embedder (ORT sessions) AFTER store is closed.
  // Releasing ORT sessions before process exit prevents the DefaultLogger crash
  // caused by C++ destructors firing after ORT's LoggingManager is torn down.
  if (embedder) {
    await embedder.dispose();
    embedder = null;
    logger.info('[knowledge] Embedder disposed.');
  }

  initializationPromise = null;
  initializationPermanentlyFailed = false;
}
