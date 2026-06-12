/**
 * Knowledge Store Operations
 *
 * Core database operations for the KnowledgeStore.
 */

import * as lancedb from '@lancedb/lancedb';
import { logger } from '../logger.ts';
import { metrics } from '../utils/metrics.ts';
import { StoreDocument } from '../core/interfaces/knowledge-interfaces.ts';

/**
 * Add documents to the store
 */
export async function addDocumentsToStore(
  table: lancedb.Table,
  docs: StoreDocument[],
  embedder: { embedMany(texts: string[]): Promise<(Float32Array | number[])[]> },
  isClosing: () => boolean,
  workspace: string,
  isGlobal: boolean
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
      vector: vectors[i]!,
      url: doc.url,
      text: doc.text,
      content: doc.content ?? null,
      metadata: JSON.stringify(doc.metadata),
      workspace,
      is_global: isGlobal,
      ingestion_type: doc.ingestion_type || (doc.metadata['ingestionType'] as string) || 'unknown',
      timestamp: BigInt(doc.timestamp),
    }));

    await table.add(data);
    const duration = Date.now() - startTime;
    metrics.observe('knowledge_store_add_documents_duration_ms', duration);
    metrics.increment('knowledge_store_add_documents_total', 1, { status: 'success' });
    metrics.increment('knowledge_store_chunks_added_total', docs.length);
    logger.log(`[store] Added ${docs.length} chunk(s) for ${docs[0]?.url} [workspace=${workspace}, global=${isGlobal}]`);
  } catch (err) {
    const duration = Date.now() - startTime;
    metrics.observe('knowledge_store_add_documents_duration_ms', duration, { status: 'error' });
    metrics.increment('knowledge_store_add_documents_total', 1, { status: 'error' });
    logger.error('[store] Failed to add documents:', err);
    throw err;
  }
}

/**
 * Search for documents in the store using hybrid search.
 *
 * Semantic search (vector similarity) targets the 'text' field (synthesis descriptions)
 * since vectors are computed from description chunks. Keyword search (BM25/FTS) targets
 * BOTH 'text' and 'content' fields — 'text' for description keywords and 'content'
 * for full article body text. Results are fused via Reciprocal Rank Fusion (RRF).
 */
export async function searchStore(
  table: lancedb.Table,
  embedder: { embed(query: string): Promise<Float32Array | number[]> },
  query: string,
  getReranker: () => Promise<lancedb.rerankers.RRFReranker>,
  limit: number,
  scopeFilter?: string
): Promise<StoreDocument[]> {
  const startTime = Date.now();

  const rowCount = await table.countRows();
  if (rowCount === 0) {
    metrics.increment('knowledge_store_search_total', 1, { status: 'empty' });
    return [];
  }

  const vector = await embedder.embed(query);

  let filter = "ingestion_type = 'synthesis-description'";
  if (scopeFilter) {
    filter = `(${filter}) AND (${scopeFilter})`;
  }

  const results = await table
    .query()
    .nearestTo(vector)
    .where(filter)
    .fullTextSearch(query, { columns: ['text', 'content'] })
    .rerank(await getReranker())
    .limit(limit)
    .toArray();

  const filteredResults = results
    .map(r => {
      let metadata: Record<string, unknown>;
      try {
        metadata = JSON.parse(r.metadata as string) as Record<string, unknown>;
      } catch {
        logger.debug('[store-operations] Corrupted metadata in searchStore, skipping row');
        return null;
      }
      return {
        url: r.url as string,
        text: r.text as string,
        content: (r.content as string | null) ?? undefined,
        metadata,
        timestamp: Number(r.timestamp),
      };
    })
    .filter((doc): doc is NonNullable<typeof doc> => doc !== null);

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
  url: string,
  scopeFilter?: string
): Promise<StoreDocument[]> {
  const startTime = Date.now();

  // Escape single quotes in URL to prevent SQL injection
  const escapedUrl = url.replace(/'/g, "''");

  let filter = `url = '${escapedUrl}'`;
  if (scopeFilter) {
    filter = `(${filter}) AND (${scopeFilter})`;
  }

  const results = await table
    .query()
    .where(filter)
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
    try { metadata = JSON.parse(r.metadata as string); } catch { logger.debug('[store-operations] Corrupted metadata in findDocumentsByUrl, skipping row'); }
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
 * Find URLs relevant to a query using hybrid search.
 *
 * Semantic search (vector) targets the 'text' field (descriptions).
 * Keyword search (BM25/FTS) targets both 'text' and 'content' fields.
 * Results are fused via RRF reranking.
 */
export async function findRelevantUrls(
  table: lancedb.Table,
  embedder: { embed(query: string): Promise<Float32Array | number[]> },
  query: string,
  getReranker: () => Promise<lancedb.rerankers.RRFReranker>,
  limit: number,
  scopeFilter?: string
): Promise<{ url: string; description: string; provenance?: string }[]> {
  const startTime = Date.now();
  const rowCount = await table.countRows();
  if (rowCount === 0) {
    metrics.increment('knowledge_store_find_urls_total', 1, { status: 'empty' });
    return [];
  }

  const vector = await embedder.embed(query);

  let filter = "ingestion_type = 'synthesis-description'";
  if (scopeFilter) {
    filter = `(${filter}) AND (${scopeFilter})`;
  }

  const results = await table
    .query()
    .nearestTo(vector)
    .where(filter)
    .fullTextSearch(query, { columns: ['text', 'content'] })
    .rerank(await getReranker())
    .limit(limit)
    .toArray();

  const entries: { url: string; description: string; provenance?: string }[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    const url = r.url as string;
    if (seen.has(url)) continue;
    seen.add(url);

    let description = '';
    let provenance = 'description-unverified';
    try {
      const meta = JSON.parse(r.metadata as string);
      description = meta.description as string ?? '';
      // Surface provenance metadata so consumers can prefer verified entries
      if (meta.provenance) provenance = meta.provenance;
      else if (meta.hasContent === true) provenance = 'scraped-verified';
    } catch { logger.debug('[store-operations] Corrupted metadata in findRelevantUrls, skipping row'); }
    
    if (!description) description = (r.text as string ?? '').substring(0, 300);
    
    // Add store scope to provenance
    const scope = r.is_global === true ? 'Global Store' : `Local Project (${r.workspace || 'unknown'})`;
    const finalProvenance = `${provenance} [${scope}]`;
    
    entries.push({ url, description, provenance: finalProvenance });
  }

  const duration = Date.now() - startTime;
  metrics.observe('knowledge_store_find_urls_duration_ms', duration);
  metrics.increment('knowledge_store_find_urls_total', 1, { status: 'success' });
  metrics.increment('knowledge_store_urls_found_total', entries.length);

  return entries;
}
