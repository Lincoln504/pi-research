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
  Int64
} from 'apache-arrow';
import * as lancedb from '@lancedb/lancedb';

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
    new Field('timestamp', new Int64(), false),
  ], new Map([['embedding_model', modelName]]));
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

  // Initial FTS index creation
  await table.createIndex('text', { config: lancedb.Index.fts() });

  return table;
}