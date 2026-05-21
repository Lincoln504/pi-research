import * as lancedb from '@lancedb/lancedb';
import { 
  Schema, 
  Field, 
  Float32, 
  FixedSizeList, 
  Utf8, 
  Int64 
} from 'apache-arrow';
import { logger } from '../logger.ts';
import type { Embedder } from './embedder.ts';
import * as fs from 'node:fs';
import { getConfig } from '../config.ts';

export interface StoreOptions {
  dbDir: string;
  embedder: Embedder;
  modelName: string;
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
        if ((storedModel as any) instanceof Uint8Array) {
          storedModel = new TextDecoder().decode(storedModel as unknown as Uint8Array);
        }
        
        if (storedModel !== this.options.modelName) {
          logger.warn(`[store] Model mismatch: expected ${this.options.modelName}, found ${storedModel}. Dropping table.`);
          await this.db.dropTable(this.tableName);
          this.table = await this.createTable();
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

  private async createTable(): Promise<lancedb.Table> {
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
      name: this.tableName,
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
      return;
    }

    this.pendingOperations++;

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
      logger.log(`[store] Added ${docs.length} chunk(s) for ${docs[0]?.url}`);
    } catch (err) {
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
    if (!this.table) throw new Error('Store not open');

    const vector = await this.options.embedder.embed(query);

    const results = await this.table
      .query()
      .nearestTo(Array.from(vector))
      .fullTextSearch(query)
      .rerank(await this.getReranker())
      .limit(options.limit ?? 5)
      .toArray();

    // Filter to only return synthesis-description entries for vector/semantic search
    // Raw-content entries are for retrieval only, not search
    const filteredResults = results
      .map(r => ({
        url: r.url as string,
        text: r.text as string,
        content: (r.content as string | null) ?? undefined,
        metadata: JSON.parse(r.metadata as string),
        timestamp: Number(r.timestamp),
      }))
      .filter(doc => doc.metadata.ingestionType === 'synthesis-description');

    return filteredResults;
  }

  /**
   * Delete all chunks for a URL. Called before re-ingesting changed content.
   */
  async deleteByUrl(url: string): Promise<void> {
    if (!this.table) throw new Error('Store not open');
    const escapedUrl = url.replace(/'/g, "''");
    await this.table.delete(`url = '${escapedUrl}'`);
    logger.log(`[store] Deleted chunks for ${url}`);
  }

  /**
   * Delete only chunks of a specific ingestionType for a URL.
   * Allows raw-content and synthesis-description to coexist independently
   * so updating one type does not evict the other.
   */
  async deleteByUrlAndType(url: string, ingestionType: string): Promise<void> {
    if (!this.table) throw new Error('Store not open');
    const escapedUrl = url.replace(/'/g, "''");
    const escapedType = ingestionType.replace(/'/g, "''");
    // metadata is stored as a JSON string — match the ingestionType value within it
    await this.table.delete(`url = '${escapedUrl}' AND metadata LIKE '%"ingestionType":"${escapedType}"%'`);
    logger.log(`[store] Deleted ${ingestionType} chunks for ${url}`);
  }

  /**
   * Find documents by exact URL match.
   * Used for deduplication - returns all chunks for the given URL.
   */
  async findByUrl(url: string): Promise<StoreDocument[]> {
    if (!this.table) throw new Error('Store not open');

    // Escape single quotes in URL to prevent SQL injection
    const escapedUrl = url.replace(/'/g, "''");

    const results = await this.table
      .query()
      .where(`url = '${escapedUrl}'`)
      .limit(1000)
      .toArray();

    if (results.length === 1000) {
      logger.warn(`[store] findByUrl hit 1000-chunk cap for ${url} — some chunks may be missing`);
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

    const escapedUrl = url.replace(/'/g, "''");

    const results = await this.table
      .query()
      .where(`url = '${escapedUrl}'`)
      .limit(10)
      .toArray();

    if (results.length === 0) return null;

    // Find the first synthesis-description row that has a populated content field.
    for (const r of results) {
      try {
        const metadata = JSON.parse(r.metadata as string);
        if (metadata.ingestionType === 'synthesis-description' && r.content) {
          logger.log(`[store] Cache hit: synthesis-description with content for ${url} (${(r.content as string).length} chars)`);
          return { text: r.content as string, metadata };
        }
      } catch { /* skip malformed row */ }
    }

    return null;
  }

  /**
   * Find unique URLs relevant to a query.
   */
  async findRelevantUrls(query: string, options: { limit?: number } = {}): Promise<string[]> {
    if (!this.table) throw new Error('Store not open');

    const vector = await this.options.embedder.embed(query);

    const results = await this.table
      .query()
      .nearestTo(Array.from(vector))
      .fullTextSearch(query)
      .rerank(await this.getReranker())
      .limit(options.limit ?? 20)
      .toArray();

    const urls = results
      .filter(r => {
        try { return JSON.parse(r.metadata as string).ingestionType === 'synthesis-description'; } catch { return false; }
      })
      .map(r => r.url as string);
    return Array.from(new Set(urls));
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
    return this.table.countRows();
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
