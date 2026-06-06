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
  /** Optional lock wrapper for multi-process safety during initialization and migration */
  withLock?: <T>(fn: () => Promise<T>) => Promise<T>;
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
  private manifestPath: string;
  private isClosing = false;
  private activeWrites = new Set<Promise<any>>();
  private rrfReranker: lancedb.rerankers.RRFReranker | null = null;
  private circuitBreaker = new CircuitBreaker({
    failureThreshold: 3,
    resetTimeoutMs: 15000,
    name: 'KnowledgeStore'
  });

  constructor(options: StoreOptions) {
    this.options = options;
    this.manifestPath = path.join(this.options.dbDir, 'store-manifest.json');
  }

  async initialize(): Promise<void> {
    this.lifecycle = ServiceLifecycle.INITIALIZING;
    await this.loadManifest();
    await this.open();
    this.lifecycle = ServiceLifecycle.INITIALIZED;
  }

  private async loadManifest(): Promise<void> {
    try {
      if (fs.existsSync(this.manifestPath)) {
        const content = await fsPromises.readFile(this.manifestPath, 'utf-8');
        const manifest = JSON.parse(content);
        if (manifest.activeTableName) {
          this.tableName = manifest.activeTableName;
          logger.debug(`[store] Loaded active table name from manifest: ${this.tableName}`);
        }
      }
    } catch (err) {
      logger.warn('[store] Failed to load manifest, using default table name:', err);
    }
  }

  private async saveManifest(): Promise<void> {
    const tempPath = `${this.manifestPath}.tmp`;
    try {
      const content = JSON.stringify({ activeTableName: this.tableName }, null, 2);
      await fsPromises.writeFile(tempPath, content, 'utf-8');
      await fsPromises.rename(tempPath, this.manifestPath);
    } catch (err) {
      logger.warn('[store] Failed to save manifest:', err);
      if (fs.existsSync(tempPath)) {
        try { await fsPromises.unlink(tempPath); } catch { /* ignore */ }
      }
    }
  }

  async open(): Promise<void> {
    if (this.db) return;

    if (this.options.withLock) {
      await this.options.withLock(() => this.openInternal());
    } else {
      await this.openInternal();
    }
  }

  private async openInternal(): Promise<void> {
    // Re-check after acquiring lock
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

    let embedded = 0;
    const batchSize = 50;
    const tempTableName = `${this.tableName}_migration_${Date.now()}`;

    try {
      // Create new table BEFORE dropping the old one to prevent data loss on failure
      logger.info(`[store] Creating new table ${tempTableName} for migration...`);
      const newTable = await this.createTable(tempTableName);

      for (let i = 0; i < totalDocs; i += batchSize) {
        const batchRows = await this.table.query().limit(batchSize).offset(i).toArray();

        const batchDocs = batchRows.map(row => ({
          url: row.url as string,
          text: row.text as string,
          content: row.content as string | undefined,
          metadata: JSON.parse(row.metadata as string),
          timestamp: Number(row.timestamp),
        }));

        const texts = batchDocs.map(d => d.text);
        const vectors = await this.options.embedder.embedMany(texts);

        const records = batchDocs.map((doc, idx) => ({
          vector: Array.from(vectors[idx]!),
          url: doc.url,
          text: doc.text,
          content: doc.content || null,
          metadata: JSON.stringify(doc.metadata),
          timestamp: BigInt(doc.timestamp),
        }));

        await newTable.add(records);
        embedded += batchDocs.length;

        if (embedded % 100 === 0 || embedded === totalDocs) {
          logger.info(`[store] Re-embedded ${embedded}/${totalDocs} documents`);
        }
      }

      // Only drop old table after successful completion
      logger.info(`[store] Migration successful, dropping old table ${this.tableName}...`);
      const canonicalName = 'knowledge'; // We try to return to the canonical name if possible
      const oldTableName = this.tableName;
      await this.db.dropTable(oldTableName);

      // LanceDB has no rename API, but its tables are plain directories on disk.
      // Rename the temp directory to the canonical table name so that the next
      // process start finds 'knowledge' (not 'knowledge_migration_<ts>').
      logger.info(`[store] Renaming ${tempTableName} to ${canonicalName}...`);
      try {
        const tempDir = path.join(this.options.dbDir, `${tempTableName}.lance`);
        const canonicalDir = path.join(this.options.dbDir, `${canonicalName}.lance`);
        
        // If canonical name was already something else and it still exists, 
        // we might need to handle it. But we just dropped it above.
        await fsPromises.rename(tempDir, canonicalDir);
        
        this.tableName = canonicalName;
        await this.saveManifest();
        
        // Reopen the canonical table so this.table reflects the renamed path
        this.table = await this.db.openTable(this.tableName);
      } catch (renameErr) {
        // If rename fails (cross-device, permissions, etc.) we keep the temp name
        // but CRITICALLY we now persist it in the manifest so future sessions
        // will find it automatically.
        logger.warn(`[store] Directory rename failed, persisting temp table name in manifest: ${renameErr}`);
        this.tableName = tempTableName;
        await this.saveManifest();
        
        this.table = newTable;
        logger.info(`[store] Migrated data is safe in ${tempTableName} and tracked via manifest.`);
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

  /**
   * Internal helper to get a fresh table handle, ensuring we see the latest
   * documents added by other processes. Re-opening a table in LanceDB is 
   * a cheap manifest re-read.
   */
  private async getFreshTable(): Promise<lancedb.Table> {
    if (!this.db) throw new Error('Store not open');
    try {
      this.table = await this.db.openTable(this.tableName);
    } catch (err) {
      if (!this.table) throw err;
      logger.debug(`[store] Failed to refresh table handle, using existing: ${err}`);
    }
    return this.table!;
  }

  async addDocuments(docs: StoreDocument[]): Promise<void> {
    const table = await this.getFreshTable();
    const writePromise = this.withEmbedderReconnect(embedder =>
      addDocumentsToStore(table, docs, embedder, () => this.isClosing)
    );
    this.activeWrites.add(writePromise);
    try {
      await writePromise;
    } finally {
      this.activeWrites.delete(writePromise);
    }
  }

  private async getReranker(): Promise<lancedb.rerankers.RRFReranker> {
    if (!this.rrfReranker) {
      this.rrfReranker = await lancedb.rerankers.RRFReranker.create();
    }
    return this.rrfReranker;
  }

  async search(query: string, options: { limit?: number } = {}): Promise<StoreDocument[]> {
    const table = await this.getFreshTable();
    return this.circuitBreaker.execute(() =>
      this.withEmbedderReconnect(embedder =>
        searchStore(table, embedder, query, this.getReranker.bind(this), options.limit ?? 5)
      )
    );
  }

  async deleteByUrl(url: string): Promise<void> {
    const table = await this.getFreshTable();
    const startTime = Date.now();
    try {
      const escapedUrl = url.replace(/'/g, "''");
      await table.delete(`url = '${escapedUrl}'`);
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
    const table = await this.getFreshTable();
    const startTime = Date.now();
    try {
      // FIX (Issue 11): Escape single quotes to prevent injection.
      // NOTE: The ingestionType is always a controlled string ("synthesis-description")
      // so LIKE wildcard chars (%) are not a practical concern. We keep the LIKE
      // pattern as-is since LanceDB/DataFusion LIKE escape syntax is undocumented.
      const escapedUrl = url.replace(/'/g, "''");
      const escapedType = ingestionType.replace(/'/g, "''");
      await table.delete(`url = '${escapedUrl}' AND metadata LIKE '%"ingestionType":"${escapedType}"%'`);
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
    const table = await this.getFreshTable();
    return findDocumentsByUrl(table, url);
  }

  async exportForWeb(outputPath: string): Promise<void> {
    const table = await this.getFreshTable();

    logger.info(`[store] Exporting knowledge store for web to: ${outputPath}`);
    
    // 1. Fetch all synthesis-description entries
    // We only want the high-quality summaries and their vectors for semantic search in the UI.
    const results = await table
      .query()
      .where("metadata LIKE '%\"ingestionType\":\"synthesis-description\"%'")
      .toArray();

    // 2. Format for web
    // We use a compact format to keep the JSON size manageable
    const exportData = results.map(r => {
      let metadata: Record<string, any> = {};
      try {
        metadata = JSON.parse(r.metadata as string);
      } catch {
        // Fallback for corrupted metadata
      }
      
      return {
        url: r.url as string,
        // The text is the summary/description
        text: r.text as string,
        // The vector is the model-dimension embedding
        v: Array.from(r.vector as Float32Array),
        // Minimal metadata needed for the UI
        m: {
          d: metadata['description'] || '',
          t: Number(r.timestamp),
        }
      };
    });

    // 3. Save to file
    try {
      const dir = path.dirname(outputPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(outputPath, JSON.stringify(exportData), 'utf-8');
      logger.info(`[store] Successfully exported ${exportData.length} entries to ${outputPath}`);
    } catch (err) {
      logger.error(`[store] Failed to export knowledge store for web:`, err);
      throw err;
    }
  }

  async findByUrl(url: string): Promise<StoreDocument[]> {
    const table = await this.getFreshTable();
    return findDocumentsByUrl(table, url);
  }

  async rebuildDocument(url: string): Promise<{ text: string; description: string | null; metadata: Record<string, any> } | null> {
    const table = await this.getFreshTable();

    const startTime = Date.now();
    const escapedUrl = url.replace(/'/g, "''");

    const results = await table
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

  async findRelevantUrls(query: string, options: { limit?: number } = {}): Promise<{ url: string; description: string; provenance?: string }[]> {
    const table = await this.getFreshTable();
    return this.circuitBreaker.execute(() =>
      this.withEmbedderReconnect(embedder =>
        findRelevantUrls(table, embedder, query, this.getReranker.bind(this), options.limit ?? 20)
      )
    );
  }

  async rebuildFtsIndex(): Promise<void> {
    const table = await this.getFreshTable();
    try {
      const count = await table.countRows();
      if (count === 0) {
        logger.debug('[store] Skipping FTS index rebuild (table is empty)');
        return;
      }
      logger.info('[store] Rebuilding FTS index...');
      await table.createIndex('text', {
        config: lancedb.Index.fts(),
        replace: true,
      });
      logger.info('[store] FTS index rebuilt.');
    } catch (err) {
      logger.warn('[store] FTS index rebuild failed:', err);
    }
  }

  private async evictOldRecords(): Promise<void> {
    const table = await this.getFreshTable();

    try {
      const config = getConfig();
      const ttlDays = config.KNOWLEDGE_STORE_CACHE_TTL_DAYS;
      if (ttlDays <= 0) return;

      const cutoffTimestamp = Date.now() - (ttlDays * 24 * 60 * 60 * 1000);
      await table.delete(`timestamp < ${BigInt(cutoffTimestamp)}`);
      logger.log(`[store] Ran eviction for records older than ${ttlDays} days`);
    } catch (err) {
      logger.warn('[store] Failed to evict old records:', err);
    }
  }

  async count(): Promise<number> {
    if (!this.db) return 0;
    const table = await this.getFreshTable();
    const count = await table.countRows();
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

    if (this.activeWrites.size > 0) {
      const maxWaitMs = 10000;
      const writesCount = this.activeWrites.size;
      let timeoutId: NodeJS.Timeout | undefined;
      try {
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error('Close timeout')), maxWaitMs);
        });
        // We don't need a .catch() on Promise.allSettled because it never rejects,
        // but we DO need to ensure the timeoutPromise rejection is caught if it fires AFTER the race.
        timeoutPromise.catch((err: Error) => logger.debug(`[store] Background timeout rejection: ${err.message}`));
        
        await Promise.race([
          Promise.allSettled(Array.from(this.activeWrites)),
          timeoutPromise
        ]);
      } catch (_err) {
        logger.warn(`[store] Closing with ${this.activeWrites.size} pending operations after timeout (started with ${writesCount})`);
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    }

    try {
      this.table = null;
      this.rrfReranker = null;
      if (this.db) {
        this.db.close();
        this.db = null;
      }
    } catch (err) {
      logger.error('[store] Error during close:', err);
    }
  }
}