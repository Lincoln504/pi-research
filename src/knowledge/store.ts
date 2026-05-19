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
import { getActiveSessionCount } from '../utils/session-state.ts';

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
  private lastIndexRebuild = 0;
  private readonly INDEX_REBUILD_DEBOUNCE_MS = 60000;

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
        if (storedModel instanceof Uint8Array) {
          storedModel = new TextDecoder().decode(storedModel);
        }
        
        if (storedModel !== this.options.modelName) {
          logger.warn(`[store] Model mismatch: expected ${this.options.modelName}, found ${storedModel}. Dropping table.`);
          await this.db.dropTable(this.tableName);
          this.table = await this.createTable();
        }
      } else {
        this.table = await this.createTable();
      }
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
    this.lastIndexRebuild = Date.now();
    
    return table;
  }

  async addDocuments(docs: StoreDocument[]): Promise<void> {
    if (!this.table) throw new Error('Store not open');

    const vectors = await this.options.embedder.embedMany(docs.map(d => d.text));
    
    const data = docs.map((doc, i) => ({
      vector: Array.from(vectors[i]),
      url: doc.url,
      text: doc.text,
      metadata: JSON.stringify(doc.metadata),
      timestamp: BigInt(doc.timestamp),
    }));

    await this.table.add(data);

    // FTS Lock Mitigation: Debounce FTS rebuilds and gate behind activeSessionCount === 0
    const now = Date.now();
    if (now - this.lastIndexRebuild > this.INDEX_REBUILD_DEBOUNCE_MS && getActiveSessionCount() === 0) {
      logger.info('[store] System idle, optimizing FTS index...');
      await this.table.createIndex('text', { 
        config: lancedb.Index.fts(),
        replace: true 
      });
      this.lastIndexRebuild = now;
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
   * Rebuild a full document from its chunks.
   */
  async rebuildDocument(url: string): Promise<string | null> {
    if (!this.table) throw new Error('Store not open');

    // Query all chunks for this URL, ordered by chunkIndex
    const results = await this.table
      .query()
      .where(`url = '${url}'`)
      .limit(1000) // reasonable limit
      .toArray();

    if (results.length === 0) return null;

    const chunks = results.map(r => ({
      text: r.text as string,
      index: JSON.parse(r.metadata as string).chunkIndex as number,
      overlap: JSON.parse(r.metadata as string).actualOverlap as number,
    })).sort((a, b) => a.index - b.index);

    if (chunks.length === 0) return null;

    let fullText = chunks[0].text;
    for (let i = 1; i < chunks.length; i++) {
      fullText += chunks[i].text.slice(chunks[i].overlap);
    }

    return fullText;
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
      .limit(options.limit ?? 20)
      .toArray();

    const urls = results.map(r => r.url as string);
    return Array.from(new Set(urls));
  }

  async close(): Promise<void> {
    this.db = null;
    this.table = null;
  }
}
