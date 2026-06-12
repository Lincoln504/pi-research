/**
 * Knowledge Store Schema
 *
 * Schema definitions and creation logic for the KnowledgeStore.
 */

import {
  Schema,
  Field,
  Float32,
  FixedSizeList,
  Utf8,
  Int64,
  Bool
} from 'apache-arrow';
import * as lancedb from '@lancedb/lancedb';

export const CURRENT_SCHEMA_VERSION = '4';

/**
 * Create the knowledge store table schema
 */
export function createStoreSchema(dim: number, modelName: string): Schema {
  return new Schema([
    new Field('vector', new FixedSizeList(dim, new Field('item', new Float32())), false),
    new Field('url', new Utf8(), false),
    new Field('text', new Utf8(), false),
    new Field('content', new Utf8(), true), // full page markdown, nullable
    new Field('metadata', new Utf8(), false), // JSON stringified
    new Field('workspace', new Utf8(), false), // local workspace path or 'global'
    new Field('is_global', new Bool(), false), // boolean indicating if it's shared globally
    new Field('ingestion_type', new Utf8(), false), // e.g. 'synthesis-description'
    new Field('timestamp', new Int64(), false),
  ], new Map([
    ['embedding_model', modelName],
    ['schema_version', CURRENT_SCHEMA_VERSION]
  ]));
}

/**
 * Create an empty table with the knowledge store schema
 */
export async function createStoreTable(
  db: lancedb.Connection,
  name: string,
  dim: number,
  modelName: string
): Promise<lancedb.Table> {
  const schema = createStoreSchema(dim, modelName);

  // Create empty table with schema and metadata
  const table = await db.createTable({
    name,
    data: [],
    schema: schema,
  });

  // Create FTS indexes for hybrid search:
  //   'text'    — synthesis descriptions (semantic search targets these via vectors)
  //   'content' — full article markdown (keyword/BM25 grep through full article contents)
  // This enables true hybrid search: semantic similarity on descriptions +
  // keyword matching across full article text, fused via RRF reranking.
  await table.createIndex('text', { config: lancedb.Index.fts() });
  await table.createIndex('content', { config: lancedb.Index.fts() });

  // Create scalar indices for performance (B-Tree)
  // These improve deleteByUrl, countRows, and evictOldRecords performance significantly as the store grows.
  await table.createIndex('url', { config: lancedb.Index.btree() });
  await table.createIndex('timestamp', { config: lancedb.Index.btree() });
  await table.createIndex('workspace', { config: lancedb.Index.btree() });
  await table.createIndex('is_global', { config: lancedb.Index.btree() });
  await table.createIndex('ingestion_type', { config: lancedb.Index.btree() });

  return table;
}