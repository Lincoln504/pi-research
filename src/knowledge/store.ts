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

  async search(query: string, options: { limit?: number } = {}): Promise<StoreDocument[]> {
    if (!this.table) throw new Error('Store not open');

    const vector = await this.options.embedder.embed(query);
    
    // Hybrid Search with RRFReranker as mandated
    const results = await this.table
      .query()
      .nearestTo(Array.from(vector))
      .fullTextSearch(query)
      .rerank(await lancedb.rerankers.RRFReranker.create())
      .limit(options.limit ?? 5)
      .toArray();

    return results.map(r => ({
      url: r.url as string,
      text: r.text as string,
      metadata: JSON.parse(r.metadata as string),
      timestamp: Number(r.timestamp),
    }));
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

    return results.map(r => ({
      url: r.url as string,
      text: r.text as string,
      metadata: JSON.parse(r.metadata as string),
      timestamp: Number(r.timestamp),
    }));
  }

  /**
   * Rebuild a full document from its chunks.
   */
  async rebuildDocument(url: string): Promise<string | null> {
    if (!this.table) throw new Error('Store not open');

    // Escape URL to prevent SQL injection
    const escapedUrl = url.replace(/'/g, "''");

    // Query all chunks for this URL, ordered by chunkIndex
    const results = await this.table
      .query()
      .where(`url = '${escapedUrl}'`)
      .limit(1000) // reasonable limit
      .toArray();

    if (results.length === 0) return null;

    const chunks = results.map(r => {
      const metadata = JSON.parse(r.metadata as string);
      return {
        text: r.text as string,
        index: metadata.chunkIndex as number,
        overlap: metadata.actualOverlap as number,
      };
    }).sort((a, b) => a.index - b.index);

    if (chunks.length === 0) return null;

    const firstChunk = chunks[0];
    if (!firstChunk) return null;

    let fullText = firstChunk.text;
    for (let i = 1; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (chunk) {
        fullText += chunk.text.slice(chunk.overlap);
      }
    }

    logger.log(`[store] Cache hit: rebuilt ${chunks.length} chunk(s) for ${url} (${fullText.length} chars)`);
    return fullText;
  }

  /**
   * Find unique URLs relevant to a query.
   */
  async findRelevantUrls(query: string, options: { limit?: number } = {}): Promise<string[]> {
    if (!this.table) throw new Error('Store not open');

    const vector = await this.options.embedder.embed(query);
    
    // Hybrid Search with RRF Reranker for proper merging of vector and FTS results
    const results = await this.table
      .query()
      .nearestTo(Array.from(vector))
      .fullTextSearch(query)
      .rerank(await lancedb.rerankers.RRFReranker.create())
      .limit(options.limit ?? 20)
      .toArray();

    const urls = results.map(r => r.url as string);
    return Array.from(new Set(urls));
  }

  /**
   * Rebuild the FTS index. Called after a research session ends so new documents
   * are visible to full-text search on the next session.
   */
  async rebuildFtsIndex(): Promise<void> {
    if (!this.table) return;
    try {
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
      logger.info(`[store] Evicted records older than ${ttlDays} days`);
    } catch (err) {
      // Don't fail initialization if eviction fails
      logger.warn('[store] Failed to evict old records:', err);
    }
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
