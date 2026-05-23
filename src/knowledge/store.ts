import * as lancedb from '@lancedb/lancedb';
import {
  Schema,
  Field,
  Float32,
  FixedSizeList,
  Utf8,
  Int64
} from 'apache-arrow';
import { CircuitBreaker } from '../utils/circuit-breaker.ts';
import { logger } from '../logger.ts';
import type { Embedder } from './embedder.ts';
import * as fs from 'node:fs';
import { getConfig } from '../config.ts';
import { MigrationStrategy, MigrationResult } from './migration.ts';
import { metrics } from '../utils/metrics.ts';

export interface StoreOptions {
  dbDir: string;
  embedder: Embedder;
  modelName: string;
  migrationStrategy?: MigrationStrategy;
}

export interface StoreDocument {
  url: string;
  text: string;
  content?: string;
  metadata: Record<string, any>;
  timestamp: number;
}

export class KnowledgeStore {
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

        // Check metadata for model mismatch
        const schema = await this.table.schema();
        let storedModel = schema.metadata.get('embedding_model');

        // Arrow metadata might be returned as Uint8Array
        if (typeof storedModel === 'object' && storedModel !== null && 'byteLength' in storedModel && 'byteOffset' in storedModel) {
          storedModel = new TextDecoder().decode(storedModel as unknown as Uint8Array);
        }

        if (storedModel !== this.options.modelName) {
          logger.warn(`[store] Model change detected: ${storedModel} → ${this.options.modelName}`);

          // Determine migration strategy (default to 'drop' for simplicity)
          const strategy = this.options.migrationStrategy || 'drop';

          try {
            await this.handleModelChange(storedModel!, this.options.modelName, strategy);
          } catch (err) {
            const errorMsg = `Model migration failed using strategy '${strategy}': ${err instanceof Error ? err.message : String(err)}`;
            logger.error(`[store] ${errorMsg}`);

            // If migration fails, fall back to drop strategy
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

      // Evict old records based on TTL
      await this.evictOldRecords();
    } catch (err) {
      logger.error('[store] Failed to open database:', err);
      throw err;
    }
  }

  /**
   * Handle model change based on the selected migration strategy.
   * Simplified to only support 'drop' and 're-embed' strategies.
   */
  private async handleModelChange(
    oldModel: string,
    newModel: string,
    strategy: MigrationStrategy
  ): Promise<MigrationResult> {
    logger.info(`[store] Executing migration strategy: ${strategy}`);
    logger.info(`[store] Old model: ${oldModel}, New model: ${newModel}`);

    switch (strategy) {
      case 'drop':
        return this.migrationDrop(oldModel, newModel);
      case 're-embed':
        return this.migrationReEmbed(oldModel, newModel);
      default:
        // Fallback to 'drop' for any unrecognized strategy
        logger.warn(`[store] Unknown migration strategy '${strategy}', falling back to 'drop'`);
        return this.migrationDrop(oldModel, newModel);
    }
  }

  /**
   * Migration strategy: Drop and recreate table (data loss).
   * Fast and simple - appropriate for local cache invalidation.
   */
  private async migrationDrop(_oldModel: string, newModel: string): Promise<MigrationResult> {
    logger.warn(`[store] Dropping table and recreating with model ${newModel} (data will be lost)`);

    const count = await this.table!.countRows();
    logger.warn(`[store] Deleting ${count} existing documents`);

    await this.db!.dropTable(this.tableName);
    this.table = await this.createTable();

    logger.info(`[store] Migration complete: ${count} documents removed, table recreated with model ${newModel}`);

    return {
      strategy: 'drop',
      success: true,
      documentsProcessed: count
    };
  }

  /**
   * Migration strategy: Re-embed all documents with new model (data preserved).
   * Simplified implementation without temp table complexity.
   */
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

    try {
      // Read all documents from old table
      for (let i = 0; i < totalDocs; i += batchSize) {
        const batchRows = await this.table.query()
          .limit(batchSize)
          .offset(i)
          .toArray();

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

      // Drop old table and create new one with correct schema
      await this.db.dropTable(this.tableName);
      this.table = await this.createTable();

      // Re-embed and insert all documents
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

        await this.table.add(records);
        embedded += batch.length;

        if (embedded % 100 === 0 || embedded === allDocs.length) {
          logger.info(`[store] Re-embedded ${embedded}/${allDocs.length} documents`);
        }
      }

      logger.info(`[store] Migration complete: ${embedded} documents re-embedded with model ${newModel}`);

      return {
        strategy: 're-embed',
        success: true,
        documentsProcessed: embedded
      };
    } catch (error) {
      logger.error(`[store] Migration failed at ${embedded}/${totalDocs}:`, error);
      throw error;
    }
  }

  private async createTable(name: string = this.tableName): Promise<lancedb.Table> {
    if (!this.db) throw new Error('Database not connected');

    const dim = this.options.embedder.getDimension();
    const schema = new Schema([
      new Field('vector', new FixedSizeList(dim, new Field('item', new Float32())), false),
      new Field('url', new Utf8(), false),
      new Field('text', new Utf8(), false),
      new Field('content', new Utf8(), true), // full page markdown, nullable
      new Field('metadata', new Utf8(), false), // JSON stringified
      new Field('timestamp', new Int64(), false),
    ], new Map([['embedding_model', this.options.modelName]]));

    // Create empty table with schema and metadata
    const table = await this.db.createTable({
      name,
      data: [],
      schema: schema,
    });

    // Initial FTS index creation
    await table.createIndex('text', { config: lancedb.Index.fts() });

    return table;
  }

  async addDocuments(docs: StoreDocument[]): Promise<void> {
    if (!this.table) throw new Error('Store not open');
    if (docs.length === 0) return;
    if (this.isClosing) {
      logger.warn('[store] Ignoring addDocuments during close');
      metrics.increment('knowledge_store_add_documents_total', 1, { status: 'ignored_closing' });
      return;
    }

    this.pendingOperations++;
    const startTime = Date.now();

    try {
      const vectors = await this.options.embedder.embedMany(docs.map(d => d.text));

      const data = docs.map((doc, i) => ({
        vector: Array.from(vectors[i]!),
        url: doc.url,
        text: doc.text,
        content: doc.content ?? null,
        metadata: JSON.stringify(doc.metadata),
        timestamp: BigInt(doc.timestamp),
      }));

      await this.table.add(data);
      const duration = Date.now() - startTime;
      metrics.observe('knowledge_store_add_documents_duration_ms', duration);
      metrics.increment('knowledge_store_add_documents_total', 1, { status: 'success' });
      metrics.increment('knowledge_store_chunks_added_total', docs.length);
      logger.log(`[store] Added ${docs.length} chunk(s) for ${docs[0]?.url}`);
    } catch (err) {
      const duration = Date.now() - startTime;
      metrics.observe('knowledge_store_add_documents_duration_ms', duration, { status: 'error' });
      metrics.increment('knowledge_store_add_documents_total', 1, { status: 'error' });
      logger.error('[store] Failed to add documents:', err);
      throw err;
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
    const startTime = Date.now();

    return this.circuitBreaker.execute(async () => {
      if (!this.table) throw new Error('Store not open');

      const rowCount = await this.table.countRows();
      if (rowCount === 0) {
        metrics.increment('knowledge_store_search_total', 1, { status: 'empty' });
        return [];
      }

      const vector = await this.options.embedder.embed(query);

      const results = await this.table
        .query()
        .nearestTo(Array.from(vector))
        .where("metadata LIKE '%\"ingestionType\":\"synthesis-description\"%'")
        .fullTextSearch(query)
        .rerank(await this.getReranker())
        .limit(options.limit ?? 5)
        .toArray();

      // The LanceDB where clause ensures we only get synthesis-description entries.
      const filteredResults = results
        .map(r => ({
          url: r.url as string,
          text: r.text as string,
          content: (r.content as string | null) ?? undefined,
          metadata: JSON.parse(r.metadata as string),
          timestamp: Number(r.timestamp),
        }))
        // Double check just in case the LIKE matched something unexpectedly
        .filter(doc => doc.metadata.ingestionType === 'synthesis-description');

      const duration = Date.now() - startTime;
      metrics.observe('knowledge_store_search_duration_ms', duration);
      metrics.increment('knowledge_store_search_total', 1, { status: 'success' });
      metrics.increment('knowledge_store_search_results_total', filteredResults.length);

      return filteredResults;
    });
  }

  /**
   * Delete all chunks for a URL. Called before re-ingesting changed content.
   */
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

  /**
   * Delete only chunks of a specific ingestionType for a URL.
   * Allows raw-content and synthesis-description to coexist independently
   * so updating one type does not evict the other.
   */
  async deleteByUrlAndType(url: string, ingestionType: string): Promise<void> {
    if (!this.table) throw new Error('Store not open');
    const startTime = Date.now();
    try {
      const escapedUrl = url.replace(/'/g, "''");
      const escapedType = ingestionType.replace(/'/g, "''");
      // metadata is stored as a JSON string - match the ingestionType value within it
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

  /**
   * Find documents by exact URL match.
   * Used for deduplication - returns all chunks for the given URL.
   */
  async findByUrl(url: string): Promise<StoreDocument[]> {
    if (!this.table) throw new Error('Store not open');

    const startTime = Date.now();

    // Escape single quotes in URL to prevent SQL injection
    const escapedUrl = url.replace(/'/g, "''");

    const results = await this.table
      .query()
      .where(`url = '${escapedUrl}'`)
      .limit(1000)
      .toArray();

    const duration = Date.now() - startTime;
    metrics.observe('knowledge_store_query_duration_ms', duration, { operation: 'find_by_url' });
    metrics.increment('knowledge_store_query_total', 1, { operation: 'find_by_url' });

    if (results.length === 1000) {
      logger.warn(`[store] findByUrl hit 1000-chunk cap for ${url} - some chunks may be missing`);
      metrics.increment('knowledge_store_query_cap_hits_total', 1);
    }

    return results.map(r => ({
      url: r.url as string,
      text: r.text as string,
      content: (r.content as string | null) ?? undefined,
      metadata: JSON.parse(r.metadata as string),
      timestamp: Number(r.timestamp),
    }));
  }

  /**
   * Return the cached full-page content for a URL.
   * Looks for a synthesis-description row that has a populated content field.
   */
  async rebuildDocument(url: string): Promise<{ text: string; metadata: Record<string, any> } | null> {
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
      metrics.increment('knowledge_store_cache_hits_total', 1, { status: 'hit' });
      logger.log(`[store] Cache hit: synthesis-description with content for ${url} (${(r.content as string).length} chars)`);
      return { text: r.content as string, metadata };
    } catch {
      metrics.increment('knowledge_store_cache_hits_total', 1, { status: 'parse_error' });
      return null;
    }
  }

  /**
   * Find unique URLs relevant to a query.
   */
  async findRelevantUrls(query: string, options: { limit?: number } = {}): Promise<string[]> {
    if (!this.table) throw new Error('Store not open');

    const startTime = Date.now();
    const rowCount = await this.table.countRows();
    if (rowCount === 0) {
      metrics.increment('knowledge_store_find_urls_total', 1, { status: 'empty' });
      return [];
    }

    const vector = await this.options.embedder.embed(query);

    const results = await this.table
      .query()
      .nearestTo(Array.from(vector))
      .where("metadata LIKE '%\"ingestionType\":\"synthesis-description\"%'")
      .fullTextSearch(query)
      .rerank(await this.getReranker())
      .limit(options.limit ?? 20)
      .toArray();

    const urls = results
      .filter(r => {
        try { return JSON.parse(r.metadata as string).ingestionType === 'synthesis-description'; } catch { return false; }
      })
      .map(r => r.url as string);
    const uniqueUrls = Array.from(new Set(urls));

    const duration = Date.now() - startTime;
    metrics.observe('knowledge_store_find_urls_duration_ms', duration);
    metrics.increment('knowledge_store_find_urls_total', 1, { status: 'success' });
    metrics.increment('knowledge_store_urls_found_total', uniqueUrls.length);

    return uniqueUrls;
  }

  /**
   * Rebuild the FTS index. Called after a research session ends so new documents
   * are visible to full-text search on the next session.
   */
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

  /**
   * Evict records older than the configured TTL.
   */
  private async evictOldRecords(): Promise<void> {
    if (!this.table) return;

    try {
      const config = getConfig();
      const ttlDays = config.KNOWLEDGE_STORE_CACHE_TTL_DAYS;
      if (ttlDays <= 0) return; // TTL disabled or invalid

      const cutoffTimestamp = Date.now() - (ttlDays * 24 * 60 * 60 * 1000);

      // Delete records older than TTL
      await this.table.delete(`timestamp < ${BigInt(cutoffTimestamp)}`);
      logger.log(`[store] Ran eviction for records older than ${ttlDays} days`);
    } catch (err) {
      // Don't fail initialization if eviction fails
      logger.warn('[store] Failed to evict old records:', err);
    }
  }

  async count(): Promise<number> {
    if (!this.table) return 0;
    const count = await this.table.countRows();
    metrics.setGauge('knowledge_store_total_documents', count);
    return count;
  }

  /**
   * Clear all data from the store by dropping and recreating the table.
   */
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

    // Wait for pending operations to complete
    const maxWaitMs = 10000; // 10 second timeout
    const startTime = Date.now();
    while (this.pendingOperations > 0 && (Date.now() - startTime) < maxWaitMs) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    if (this.pendingOperations > 0) {
      logger.warn(`[store] Closing with ${this.pendingOperations} pending operations`);
    }

    try {
      if (this.table) {
        // LanceDB tables are automatically flushed, but we can ensure cleanup
        this.table = null;
      }
      if (this.db) {
        // LanceDB connection cleanup
        this.db = null;
      }
    } catch (err) {
      logger.error('[store] Error during close:', err);
    }
  }
}