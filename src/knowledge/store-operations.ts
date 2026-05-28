/**
 * Knowledge Store Operations
 *
 * Core database operations for the KnowledgeStore.
 */

import * as lancedb from '@lancedb/lancedb';
import { logger } from '../logger.ts';
import { metrics } from '../utils/metrics.ts';
import type { StoreDocument } from './store-types.ts';

/**
 * Add documents to the store
 */
export async function addDocumentsToStore(
  table: lancedb.Table,
  docs: StoreDocument[],
  embedder: { embedMany(texts: string[]): Promise<Float32Array[]> },
  isClosing: () => boolean
): Promise<void> {
  if (docs.length === 0) return;
  if (isClosing()) {
    logger.warn('[store] Ignoring addDocuments during close');
    metrics.increment('knowledge_store_add_documents_total', 1, { status: 'ignored_closing' });
    return;
  }

  const startTime = Date.now();

  try {
    const vectors = await embedder.embedMany(docs.map(d => d.text));

    const data = docs.map((doc, i) => ({
      vector: Array.from(vectors[i]!),
      url: doc.url,
      text: doc.text,
      content: doc.content ?? null,
      metadata: JSON.stringify(doc.metadata),
      timestamp: BigInt(doc.timestamp),
    }));

    await table.add(data);
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
  }
}

/**
 * Search for documents in the store
 */
export async function searchStore(
  table: lancedb.Table,
  embedder: { embed(query: string): Promise<Float32Array> },
  query: string,
  getReranker: () => Promise<lancedb.rerankers.RRFReranker>,
  limit: number
): Promise<StoreDocument[]> {
  const startTime = Date.now();

  const rowCount = await table.countRows();
  if (rowCount === 0) {
    metrics.increment('knowledge_store_search_total', 1, { status: 'empty' });
    return [];
  }

  const vector = await embedder.embed(query);

  const results = await table
    .query()
    .nearestTo(Array.from(vector))
    .where("metadata LIKE '%\"ingestionType\":\"synthesis-description\"%'")
    .fullTextSearch(query)
    .rerank(await getReranker())
    .limit(limit)
    .toArray();

  const filteredResults = results
    .map(r => {
      let metadata: Record<string, unknown> = {};
      try { metadata = JSON.parse(r.metadata as string); } catch { /* corrupted row — skip */ }
      return {
        url: r.url as string,
        text: r.text as string,
        content: (r.content as string | null) ?? undefined,
        metadata,
        timestamp: Number(r.timestamp),
      };
    })
    .filter(doc => doc.metadata['ingestionType'] === 'synthesis-description');

  const duration = Date.now() - startTime;
  metrics.observe('knowledge_store_search_duration_ms', duration);
  metrics.increment('knowledge_store_search_total', 1, { status: 'success' });
  metrics.increment('knowledge_store_search_results_total', filteredResults.length);

  return filteredResults;
}

/**
 * Find documents by URL
 */
export async function findDocumentsByUrl(
  table: lancedb.Table,
  url: string
): Promise<StoreDocument[]> {
  const startTime = Date.now();

  // Escape single quotes in URL to prevent SQL injection
  const escapedUrl = url.replace(/'/g, "''");

  const results = await table
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

  return results.map(r => {
    let metadata: Record<string, unknown> = {};
    try { metadata = JSON.parse(r.metadata as string); } catch { /* corrupted row */ }
    return {
    url: r.url as string,
    text: r.text as string,
    content: (r.content as string | null) ?? undefined,
    metadata,
    timestamp: Number(r.timestamp),
    };
  });
}

/**
 * Find URLs relevant to a query
 */
export async function findRelevantUrls(
  table: lancedb.Table,
  embedder: { embed(query: string): Promise<Float32Array> },
  query: string,
  getReranker: () => Promise<lancedb.rerankers.RRFReranker>,
  limit: number
): Promise<string[]> {
  const startTime = Date.now();
  const rowCount = await table.countRows();
  if (rowCount === 0) {
    metrics.increment('knowledge_store_find_urls_total', 1, { status: 'empty' });
    return [];
  }

  const vector = await embedder.embed(query);

  const results = await table
    .query()
    .nearestTo(Array.from(vector))
    .where("metadata LIKE '%\"ingestionType\":\"synthesis-description\"%'")
    .fullTextSearch(query)
    .rerank(await getReranker())
    .limit(limit)
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