import { KnowledgeStore } from './store.ts';
import { WriterQueue } from './writer-queue.ts';
import { Chunker } from './chunker.ts';
import { getConfig, validateConfig, getDbDir } from '../config.ts';
import { logger } from '../logger.ts';
import * as fs from 'node:fs';
import type { MigrationStrategy } from './migration.ts';
import type { IEmbedder } from '../core/interfaces/knowledge-interfaces.ts';
export { SUPPORTED_MODELS, getModelEmbedderConfig, getModelChunkConfig } from './model-config.ts';

/** Migration strategy for model changes (read from env or config) */
function getMigrationStrategy(): MigrationStrategy | undefined {
  const strategy = process.env['PI_RESEARCH_MIGRATION_STRATEGY'];
  if (!strategy) return undefined;
  
  // Only support 'drop' and 're-embed' - simplified from 4 strategies
  const validStrategies: MigrationStrategy[] = ['drop', 're-embed'];
  if (validStrategies.includes(strategy as MigrationStrategy)) {
    return strategy as MigrationStrategy;
  }
  
  logger.warn(`[knowledge] Invalid migration strategy '${strategy}'. Valid options: drop, re-embed. Falling back to default (drop).`);
  return undefined;
}

import { getModelChunkConfig } from './model-config.ts';

/**
 * Result of knowledge store initialization
 */
export interface KnowledgeStoreComponents {
  embedder: IEmbedder;
  store: KnowledgeStore;
  writerQueue: WriterQueue;
}

const MAX_INIT_RETRIES = 5;
const BASE_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 30000;

/**
 * Initialize knowledge store components.
 * This is a factory function used by KnowledgeStoreService.
 * @param embedderFactory - Returns an IEmbedder for the initial connection.
 * @param reconnectFactory - Returns a fresh IEmbedder when the server dies mid-session.
 */
export async function createKnowledgeStoreComponents(
  embedderFactory: () => Promise<IEmbedder>,
  reconnectFactory?: () => Promise<IEmbedder>
): Promise<KnowledgeStoreComponents> {
  const config = getConfig();
  if (!config.KNOWLEDGE_STORE_ENABLED) {
    throw new Error('Knowledge store is disabled in configuration');
  }
  validateConfig(config);

  for (let attempt = 1; attempt <= MAX_INIT_RETRIES; attempt++) {
    try {
      logger.info(`[knowledge] Creating Knowledge Store components (attempt ${attempt}/${MAX_INIT_RETRIES})...`);

      // The embedderFactory handles leader election/startup via infrastructure
      const embedder = await embedderFactory();

      const migrationStrategy = getMigrationStrategy();
      const store = new KnowledgeStore({
        dbDir: getDbDir(),
        embedder,
        modelName: config.EMBEDDING_MODEL,
        migrationStrategy: migrationStrategy,
        reconnectFactory,
      });

      const chunkCfg = getModelChunkConfig(config.EMBEDDING_MODEL);
      const chunkOverlap = Math.round(chunkCfg.chunkSize * chunkCfg.overlapPct);
      const chunker = new Chunker({ targetSize: chunkCfg.chunkSize, overlap: chunkOverlap });
      const writerQueue = new WriterQueue({ store: store, chunker });

      await store.open();

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
