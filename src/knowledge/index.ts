import * as fs from 'node:fs';
import { KnowledgeStore } from './store.ts';
import { WriterQueue } from './writer-queue.ts';
import { Chunker } from './chunker.ts';
import { getConfig, validateConfig, getDbDir, type Config } from '../config.ts';
import { logger } from '../logger.ts';
import { getModelChunkConfig } from './model-config.ts';
import type { MigrationStrategy } from './migration.ts';
import type { 
  IEmbedder, 
  IKnowledgeStore 
} from '../core/interfaces/knowledge-interfaces.ts';

export { SUPPORTED_MODELS, getModelEmbedderConfig, getModelChunkConfig } from './model-config.ts';

/** Migration strategy for model changes (read from config) */
function getMigrationStrategy(config: Config): MigrationStrategy | undefined {
  const strategy = config.MIGRATION_STRATEGY;
  if (!strategy) return undefined;
  
  const validStrategies: MigrationStrategy[] = ['drop', 're-embed', 'backup'];
  if (validStrategies.includes(strategy as MigrationStrategy)) {
    return strategy as MigrationStrategy;
  }
  
  logger.warn(`[knowledge] Invalid migration strategy '${strategy}'. Valid options: drop, re-embed, backup. Falling back to default (backup).`);
  return undefined;
}

/**
 * Result of knowledge store initialization
 */
export interface KnowledgeStoreComponents {
  embedder: IEmbedder;
  store: IKnowledgeStore;
  writerQueue: WriterQueue;
}

const MAX_INIT_RETRIES = 5;
const BASE_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 30000;

/**
 * Initialize knowledge store components.
 */
export async function createKnowledgeStoreComponents(
  embedderFactory: () => Promise<IEmbedder>,
  reconnectFactory?: () => Promise<IEmbedder>,
  withLock?: <T>(fn: () => Promise<T>) => Promise<T>,
  config: Config = getConfig(),
  workspace: string = process.cwd()
): Promise<KnowledgeStoreComponents | null> {
  if (config.KNOWLEDGE_STORE_MODE === 'none') {
    logger.debug('[knowledge] Knowledge store is disabled in configuration');
    return null;
  }
  validateConfig(config);

  for (let attempt = 1; attempt <= MAX_INIT_RETRIES; attempt++) {
    try {
      logger.info(`[knowledge] Creating Knowledge Store components (attempt ${attempt}/${MAX_INIT_RETRIES})...`);

      const embedder = await embedderFactory();
      const migrationStrategy = getMigrationStrategy(config);
      
      const store = new KnowledgeStore({
        dbDir: getDbDir(config, workspace),
        embedder,
        modelName: config.EMBEDDING_MODEL,
        migrationStrategy: migrationStrategy,
        reconnectFactory,
        withLock,
        workspace,
        knowledgeMode: config.KNOWLEDGE_STORE_MODE,
        ttlDays: config.KNOWLEDGE_STORE_CACHE_TTL_DAYS,
      });

      const chunkCfg = getModelChunkConfig(config.EMBEDDING_MODEL);
      const chunkOverlap = Math.round(chunkCfg.chunkSize * chunkCfg.overlapPct);
      const chunker = new Chunker({ targetSize: chunkCfg.chunkSize, overlap: chunkOverlap });
      const writerQueue = new WriterQueue({ store, chunker });

      await store.initialize();

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

/**
 * Force delete the entire knowledge database directory.
 * Used for system-level clearing or recovery from corruption.
 */
export async function forceDeleteKnowledgeStore(config?: Config, workspace?: string): Promise<void> {
  const dbDir = getDbDir(config, workspace);
  if (fs.existsSync(dbDir)) {
    try {
      fs.rmSync(dbDir, { recursive: true, force: true });
      fs.mkdirSync(dbDir, { recursive: true });
      logger.info(`[knowledge] Knowledge store at ${dbDir} forcefully deleted and recreated.`);
    } catch (err) {
      logger.error(`[knowledge] Failed to forcefully delete directory ${dbDir}:`, err);
      throw err;
    }
  }
}
