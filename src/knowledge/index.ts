import * as fs from 'node:fs';
import * as path from 'node:path';
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
    let store: KnowledgeStore | undefined;
    try {
      logger.info(`[knowledge] Creating Knowledge Store components (attempt ${attempt}/${MAX_INIT_RETRIES})...`);

      const embedder = await embedderFactory();
      const migrationStrategy = getMigrationStrategy(config);

      store = new KnowledgeStore({
        dbDir: getDbDir(config, workspace),
        embedder,
        modelName: config.EMBEDDING_MODEL,
        migrationStrategy: migrationStrategy,
        reconnectFactory,
        withLock,
        workspace,
        knowledgeMode: config.KNOWLEDGE_STORE_MODE,
        ttlDays: config.KNOWLEDGE_STORE_CACHE_TTL_DAYS,
        maxServeAgeDays: config.KNOWLEDGE_STORE_MAX_SERVE_AGE_DAYS,
      });

      const chunkCfg = getModelChunkConfig(config.EMBEDDING_MODEL);
      const chunkOverlap = Math.round(chunkCfg.chunkSize * chunkCfg.overlapPct);
      const chunker = new Chunker({ targetSize: chunkCfg.chunkSize, overlap: chunkOverlap });
      const writerQueue = new WriterQueue({ store, chunker });

      await store.initialize();

      return { embedder, store, writerQueue };
    } catch (err) {
      // Close any partially-opened store before retrying/giving up: store.initialize()
      // can throw AFTER lancedb.connect() set its db handle, and discarding the object
      // without close() leaks the LanceDB connection/file handles (up to MAX_INIT_RETRIES
      // times per failing startup).
      if (store) {
        try { await store.close(); } catch { /* best-effort cleanup */ }
      }
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
 * Force delete the ACTIVE table's own directory, to recover from a corrupted
 * LanceDB manifest. Scoped to that one table, not the whole dbDir: dbDir is a
 * single unified store shared by every workspace and the global scope (rows
 * are scoped by a `workspace` column, not by separate directories), and it
 * also holds `_backup_*`/`_migration_*` sibling directories — the deliberate,
 * user-recoverable safety net the 'backup' migration strategy creates. A
 * directory-wide wipe here previously destroyed every other project's data
 * and every backup the instant ANY workspace's session hit a corrupted
 * manifest, on the one code path whose entire purpose is recovering from
 * exactly that kind of damage.
 */
export async function forceDeleteKnowledgeStore(config?: Config, workspace?: string): Promise<void> {
  const dbDir = getDbDir(config, workspace);
  if (!fs.existsSync(dbDir)) return;

  // Mirrors KnowledgeStore's own manifest read (store.ts): the active table
  // name defaults to 'knowledge' but can point elsewhere after a persisted
  // rename failure. A missing or unreadable manifest is not itself a reason to
  // widen the blast radius, so it falls back to the default rather than
  // escalating to a dbDir-wide delete.
  let tableName = 'knowledge';
  const manifestPath = path.join(dbDir, 'store-manifest.json');
  try {
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as { activeTableName?: string };
      if (manifest.activeTableName) tableName = manifest.activeTableName;
    }
  } catch (err) {
    logger.warn(`[knowledge] Failed to read manifest before forced delete, defaulting to table '${tableName}':`, err);
  }

  const tableDir = path.join(dbDir, `${tableName}.lance`);
  if (!fs.existsSync(tableDir)) return;
  try {
    fs.rmSync(tableDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    logger.info(`[knowledge] Corrupted table directory ${tableDir} forcefully deleted; will be recreated on next init.`);
  } catch (err) {
    logger.error(`[knowledge] Failed to forcefully delete table directory ${tableDir}:`, err);
    throw err;
  }
}
