/**
 * Knowledge Store
 *
 * Vector database for storing and retrieving research documents using LanceDB.
 */

import * as lancedb from '@lancedb/lancedb';
import { CircuitBreaker } from '../utils/circuit-breaker.ts';
import { logger } from '../logger.ts';
import type { IEmbedder } from '../core/interfaces/knowledge-interfaces.ts';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { getConfig } from '../config.ts';
import { MigrationStrategy, MigrationResult } from './migration.ts';
import { metrics } from '../utils/metrics.ts';
import { createStoreTable } from './store-schema.ts';
import { addDocumentsToStore, searchStore, findDocumentsByUrl, findRelevantUrls } from './store-operations.ts';
import type { StoreDocument } from './store-types.ts';
import { ServiceLifecycle } from '../core/service-registry.ts';
import { ServiceNames } from '../core/interfaces/service-names.ts';
import type { IKnowledgeStore } from '../core/interfaces/knowledge-interfaces.ts';

export interface StoreOptions {
  dbDir: string;
  embedder: IEmbedder;
  modelName: string;
  migrationStrategy?: MigrationStrategy;
  /** Called when embedder connection fails — should return a fresh IEmbedder. */
  reconnectFactory?: () => Promise<IEmbedder>;
}

function isConnectionRefused(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('ECONNREFUSED');
}

export class KnowledgeStore implements IKnowledgeStore {
  readonly name = ServiceNames.KNOWLEDGE_STORE;
  lifecycle = ServiceLifecycle.UNINITIALIZED;

  private db: lancedb.Connection | null = null;
  private table: lancedb.Table | null = null;
  private options: StoreOptions;
  private tableName = 'knowledge';
  private isClosing = false;
  private pendingOperations = 0;
  private rrfReranker: lancedb.rerankers.RRFReranker | null = null;
  private circuitBreaker = new CircuitBreaker({
    failureThreshold: 3,
    resetTimeoutMs: 15000,
    name: 'KnowledgeStore'
  });

  constructor(options: StoreOptions) {
    this.options = options;
  }

  async initialize(): Promise<void> {
    this.lifecycle = ServiceLifecycle.INITIALIZING;
    await this.open();
    this.lifecycle = ServiceLifecycle.INITIALIZED;
  }

  async open(): Promise<void> {
    if (this.db) return;

    try {
      if (!fs.existsSync(this.options.dbDir)) {
        fs.mkdirSync(this.options.dbDir, { recursive: true });
      }
      this.db = await lancedb.connect(this.options.dbDir);

      const tableNames = await this.db.tableNames();
      if (tableNames.includes(this.tableName)) {
        this.table = await this.db.openTable(this.tableName);

        try {
          const schema = await this.table.schema();
          const vectorField = schema.fields.find(f => f.name === 'vector');
          // Fix for FixedSizeList: check type name or use any if lancedb doesn't export it
          if (vectorField && (vectorField.type as any).constructor.name === 'FixedSizeList') {
            const dim = (vectorField.type as any).listSize;
            if (this.options.embedder.getDimension() === null) {
              (this.options.embedder as any).dimension = dim;
              logger.debug(`[store] Extracted dimension ${dim} from existing table schema`);
            }
          }
        } catch (schemaErr) {
          logger.warn('[store] Failed to extract dimension from schema:', schemaErr);
        }

        const schema = await this.table.schema();
        let storedModel = schema.metadata.get('embedding_model');

        if (typeof storedModel === 'object' && storedModel !== null && 'byteLength' in storedModel && 'byteOffset' in storedModel) {
          storedModel = new TextDecoder().decode(storedModel as unknown as Uint8Array);
        }

        if (storedModel !== this.options.modelName) {
          logger.warn(`[store] Model change detected: ${storedModel} → ${this.options.modelName}`);
          const strategy = this.options.migrationStrategy || 'drop';

          try {
            await this.handleModelChange(storedModel!, this.options.modelName, strategy);
          } catch (err) {
            const errorMsg = `Model migration failed using strategy '${strategy}': ${err instanceof Error ? err.message : String(err)}`;
            logger.error(`[store] ${errorMsg}`);

            if (strategy !== 'drop') {
              logger.warn('[store] Falling back to drop strategy after migration failure');
              await this.db.dropTable(this.tableName);
              this.table = await this.createTable();
            } else {
              throw new Error(errorMsg, { cause: err });
            }
          }
        }
      } else {
        this.table = await this.createTable();
      }

      await this.evictOldRecords();
    } catch (err) {
      logger.error('[store] Failed to open database:', err);
      throw err;
    }
  }

  private async handleModelChange(oldModel: string, newModel: string, strategy: MigrationStrategy): Promise<MigrationResult> {
    logger.info(`[store] Executing migration strategy: ${strategy}`);
    logger.info(`[store] Old model: ${oldModel}, New model: ${newModel}`);

    switch (strategy) {
      case 'drop':
        return this.migrationDrop(oldModel, newModel);
      case 're-embed':
        return this.migrationReEmbed(oldModel, newModel);
      default:
        logger.warn(`[store] Unknown migration strategy '${strategy}', falling back to 'drop'`);
        return this.migrationDrop(oldModel, newModel);
    }
  }

  private async migrationDrop(_oldModel: string, newModel: string): Promise<MigrationResult> {
    logger.warn(`[store] Dropping table and recreating with model ${newModel} (data will be lost)`);

    if (!this.table || !this.db) {
      throw new Error('Table not connected');
    }

    const count = await this.table.countRows();
    logger.warn(`[store] Deleting ${count} existing documents`);

    await this.db.dropTable(this.tableName);
    this.table = await this.createTable();

    logger.info(`[store] Migration complete: ${count} documents removed, table recreated with model ${newModel}`);

    return { strategy: 'drop', success: true, documentsProcessed: count };
  }

  private async migrationReEmbed(_oldModel: string, newModel: string): Promise<MigrationResult> {
    logger.info(`[store] Re-embedding documents with model ${newModel} (data will be preserved)`);

    if (!this.table || !this.db) {
      throw new Error('Table not connected');
    }

    const totalDocs = await this.table.countRows();
    logger.info(`[store] Processing ${totalDocs} documents for re-embedding...`);

    let processed = 0;
    let embedded = 0;
    const batchSize = 50;
    const allDocs: StoreDocument[] = [];
    const tempTableName = `${this.tableName}_migration_${Date.now()}`;

    try {
      for (let i = 0; i < totalDocs; i += batchSize) {
        const batchRows = await this.table.query().limit(batchSize).offset(i).toArray();

        const batchDocs = batchRows.map(row => ({
          url: row.url as string,
          text: row.text as string,
          content: row.content as string | undefined,
          metadata: JSON.parse(row.metadata as string),
          timestamp: Number(row.timestamp),
        }));

        allDocs.push(...batchDocs);
        processed += batchDocs.length;

        if (processed % 500 === 0 || processed === totalDocs) {
          logger.info(`[store] Read ${processed}/${totalDocs} documents from old table`);
        }
      }

      // Create new table BEFORE dropping the old one to prevent data loss on failure
      logger.info(`[store] Creating new table ${tempTableName} for migration...`);
      const newTable = await this.createTable(tempTableName);

      for (let i = 0; i < allDocs.length; i += batchSize) {
        const batch = allDocs.slice(i, i + batchSize);
        const texts = batch.map(d => d.text);
        const vectors = await this.options.embedder.embedMany(texts);

        const records = batch.map((doc, idx) => ({
          vector: Array.from(vectors[idx]!),
          url: doc.url,
          text: doc.text,
          content: doc.content || null,
          metadata: JSON.stringify(doc.metadata),
          timestamp: BigInt(doc.timestamp),
        }));

        await newTable.add(records);
        embedded += batch.length;

        if (embedded % 100 === 0 || embedded === allDocs.length) {
          logger.info(`[store] Re-embedded ${embedded}/${allDocs.length} documents`);
        }
      }

      // Only drop old table after successful completion
      logger.info(`[store] Migration successful, dropping old table ${this.tableName}...`);
      const canonicalName = this.tableName;
      await this.db.dropTable(canonicalName);

      // LanceDB has no rename API, but its tables are plain directories on disk.
      // Rename the temp directory to the canonical table name so that the next
      // process start finds 'knowledge' (not 'knowledge_migration_<ts>').
      logger.info(`[store] Renaming ${tempTableName} to ${canonicalName}...`);
      try {
        const tempDir = path.join(this.options.dbDir, `${tempTableName}.lance`);
        const canonicalDir = path.join(this.options.dbDir, `${canonicalName}.lance`);
        await fsPromises.rename(tempDir, canonicalDir);
        // Reopen the canonical table so this.table reflects the renamed path
        this.table = await this.db.openTable(canonicalName);
      } catch (renameErr) {
        // If rename fails (cross-device, permissions, etc.) fall back to keeping
        // the temp name. We MUST update this.tableName so that findRelevantUrls/search
        // continue to work, and future sessions MIGHT need manual intervention or
        // we could implement a discovery mechanism. For now, we at least don't lose
        // the in-memory connection to the new data.
        logger.warn(`[store] Directory rename failed, keeping temp table name: ${renameErr}`);
        this.tableName = tempTableName;
        this.table = newTable;
        
        // Persist the new table name if possible, or at least log it loudly.
        // Since we don't have a metadata file for the store itself yet, we log it.
        logger.error(`[store] CRITICAL: Migrated data is in ${tempTableName}. Next start will NOT find it automatically.`);
      }

      logger.info(`[store] Migration complete: ${embedded} documents re-embedded with model ${newModel}`);

      return { strategy: 're-embed', success: true, documentsProcessed: embedded };
    } catch (error) {
      logger.error(`[store] Migration failed at ${embedded}/${totalDocs}:`, error);
      logger.error(`[store] Original data is still intact in table ${this.tableName}`);
      throw error;
    }
  }

  private async createTable(name: string = this.tableName): Promise<lancedb.Table> {
    if (!this.db) throw new Error('Database not connected');
    const dim = this.options.embedder.getDimension();
    if (dim === null) throw new Error('[store] Cannot create table: embedder dimension unknown (not yet initialized)');
    return createStoreTable(this.db, name, dim, this.options.modelName);
  }

  private async withEmbedderReconnect<T>(fn: (embedder: IEmbedder) => Promise<T>): Promise<T> {
    try {
      return await fn(this.options.embedder);
    } catch (err) {
      if (isConnectionRefused(err) && this.options.reconnectFactory) {
        logger.warn('[store] Embedder server unreachable, reconnecting and retrying...');
        this.options.embedder = await this.options.reconnectFactory();
        return fn(this.options.embedder);
      }
      throw err;
    }
  }

  async addDocuments(docs: StoreDocument[]): Promise<void> {
    if (!this.table) throw new Error('Store not open');
    this.pendingOperations++;
    try {
      await this.withEmbedderReconnect(embedder =>
        addDocumentsToStore(this.table!, docs, embedder, () => this.isClosing)
      );
    } finally {
      this.pendingOperations--;
    }
  }

  private async getReranker(): Promise<lancedb.rerankers.RRFReranker> {
    if (!this.rrfReranker) {
      this.rrfReranker = await lancedb.rerankers.RRFReranker.create();
    }
    return this.rrfReranker;
  }

  async search(query: string, options: { limit?: number } = {}): Promise<StoreDocument[]> {
    if (!this.table) throw new Error('Store not open');
    return this.circuitBreaker.execute(() =>
      this.withEmbedderReconnect(embedder =>
        searchStore(this.table!, embedder, query, this.getReranker.bind(this), options.limit ?? 5)
      )
    );
  }

  async deleteByUrl(url: string): Promise<void> {
    if (!this.table) throw new Error('Store not open');
    const startTime = Date.now();
    try {
      const escapedUrl = url.replace(/'/g, "''");
      await this.table.delete(`url = '${escapedUrl}'`);
      const duration = Date.now() - startTime;
      metrics.observe('knowledge_store_delete_duration_ms', duration);
      metrics.increment('knowledge_store_delete_total', 1, { operation: 'by_url', status: 'success' });
      logger.log(`[store] Deleted chunks for ${url}`);
    } catch (err) {
      const duration = Date.now() - startTime;
      metrics.observe('knowledge_store_delete_duration_ms', duration, { status: 'error' });
      metrics.increment('knowledge_store_delete_total', 1, { operation: 'by_url', status: 'error' });
      throw err;
    }
  }

  async deleteByUrlAndType(url: string, ingestionType: string): Promise<void> {
    if (!this.table) throw new Error('Store not open');
    const startTime = Date.now();
    try {
      const escapedUrl = url.replace(/'/g, "''");
      const escapedType = ingestionType.replace(/'/g, "''");
      await this.table.delete(`url = '${escapedUrl}' AND metadata LIKE '%"ingestionType":"${escapedType}"%'`);
      const duration = Date.now() - startTime;
      metrics.observe('knowledge_store_delete_duration_ms', duration, { operation: 'by_url_and_type' });
      metrics.increment('knowledge_store_delete_total', 1, { operation: 'by_url_and_type', status: 'success' });
      logger.log(`[store] Deleted ${ingestionType} chunks for ${url}`);
    } catch (err) {
      const duration = Date.now() - startTime;
      metrics.observe('knowledge_store_delete_duration_ms', duration, { operation: 'by_url_and_type', status: 'error' });
      metrics.increment('knowledge_store_delete_total', 1, { operation: 'by_url_and_type', status: 'error' });
      throw err;
    }
  }

  async findDocumentsByUrl(url: string): Promise<StoreDocument[]> {
    if (!this.table) throw new Error('Store not open');
    return findDocumentsByUrl(this.table, url);
  }

  async findByUrl(url: string): Promise<StoreDocument[]> {
    if (!this.table) throw new Error('Store not open');
    return findDocumentsByUrl(this.table, url);
  }

  async rebuildDocument(url: string): Promise<{ text: string; description: string | null; metadata: Record<string, any> } | null> {
    if (!this.table) throw new Error('Store not open');

    const startTime = Date.now();
    const escapedUrl = url.replace(/'/g, "''");

    const results = await this.table
      .query()
      .where(`url = '${escapedUrl}' AND metadata LIKE '%"ingestionType":"synthesis-description"%' AND content IS NOT NULL`)
      .limit(1)
      .toArray();

    const duration = Date.now() - startTime;
    metrics.observe('knowledge_store_query_duration_ms', duration, { operation: 'rebuild_document' });
    metrics.increment('knowledge_store_query_total', 1, { operation: 'rebuild_document' });

    if (results.length === 0) {
      metrics.increment('knowledge_store_cache_hits_total', 1, { status: 'miss' });
      return null;
    }

    const r = results[0];
    try {
      const metadata = JSON.parse(r.metadata as string);
      const description: string | null = typeof metadata.description === 'string' ? metadata.description : null;
      metrics.increment('knowledge_store_cache_hits_total', 1, { status: 'hit' });
      logger.log(`[store] Cache hit: synthesis-description with content for ${url} (${(r.content as string).length} chars)`);
      return { text: r.content as string, description, metadata };
    } catch {
      metrics.increment('knowledge_store_cache_hits_total', 1, { status: 'parse_error' });
      return null;
    }
  }

  async findRelevantUrls(query: string, options: { limit?: number } = {}): Promise<{ url: string; description: string }[]> {
    if (!this.table) throw new Error('Store not open');
    return this.circuitBreaker.execute(() =>
      this.withEmbedderReconnect(embedder =>
        findRelevantUrls(this.table!, embedder, query, this.getReranker.bind(this), options.limit ?? 20)
      )
    );
  }

  async rebuildFtsIndex(): Promise<void> {
    if (!this.table) return;
    try {
      const count = await this.table.countRows();
      if (count === 0) {
        logger.debug('[store] Skipping FTS index rebuild (table is empty)');
        return;
      }
      logger.info('[store] Rebuilding FTS index...');
      await this.table.createIndex('text', {
        config: lancedb.Index.fts(),
        replace: true,
      });
      logger.info('[store] FTS index rebuilt.');
    } catch (err) {
      logger.warn('[store] FTS index rebuild failed:', err);
    }
  }

  private async evictOldRecords(): Promise<void> {
    if (!this.table) return;

    try {
      const config = getConfig();
      const ttlDays = config.KNOWLEDGE_STORE_CACHE_TTL_DAYS;
      if (ttlDays <= 0) return;

      const cutoffTimestamp = Date.now() - (ttlDays * 24 * 60 * 60 * 1000);
      await this.table.delete(`timestamp < ${BigInt(cutoffTimestamp)}`);
      logger.log(`[store] Ran eviction for records older than ${ttlDays} days`);
    } catch (err) {
      logger.warn('[store] Failed to evict old records:', err);
    }
  }

  async count(): Promise<number> {
    if (!this.table || !this.db) return 0;
    // Reopen the table handle to pick up the latest manifest version.
    // LanceDB table handles pin to the dataset snapshot at open time; rows
    // appended via add() since then won't appear in countRows() until the
    // handle is refreshed. This is a cheap manifest re-read, not a full scan.
    try {
      this.table = await this.db.openTable(this.tableName);
    } catch (err) {
      logger.debug('[store] count(): failed to refresh table handle, proceeding with existing:', err);
    }
    const count = await this.table.countRows();
    metrics.setGauge('knowledge_store_total_documents', count);
    return count;
  }

  async clear(): Promise<void> {
    if (!this.db) throw new Error('Store not open');

    const startTime = Date.now();
    try {
      this.table = null;
      await this.db.dropTable(this.tableName);
      this.table = await this.createTable();
      const duration = Date.now() - startTime;
      metrics.observe('knowledge_store_clear_duration_ms', duration);
      metrics.increment('knowledge_store_clear_total', 1, { status: 'success' });
      metrics.setGauge('knowledge_store_total_documents', 0);
      logger.info('[store] Knowledge store cleared.');
    } catch (err) {
      const duration = Date.now() - startTime;
      metrics.observe('knowledge_store_clear_duration_ms', duration, { status: 'error' });
      metrics.increment('knowledge_store_clear_total', 1, { status: 'error' });
      logger.error('[store] Failed to clear knowledge store:', err);
      throw err;
    }
  }

  isStoreClosed(): boolean {
    return this.isClosing;
  }

  async close(): Promise<void> {
    this.isClosing = true;

    const maxWaitMs = 10000;
    const startTime = Date.now();
    while (this.pendingOperations > 0 && (Date.now() - startTime) < maxWaitMs) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    if (this.pendingOperations > 0) {
      logger.warn(`[store] Closing with ${this.pendingOperations} pending operations`);
    }

    try {
      this.table = null;
      if (this.db) {
        this.db.close();
        this.db = null;
      }
    } catch (err) {
      logger.error('[store] Error during close:', err);
    }
  }
}