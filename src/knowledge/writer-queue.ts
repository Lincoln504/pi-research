import { logger } from '../logger.ts';
import type { Chunker } from './chunker.ts';
import { createHash } from 'node:crypto';
import { ServiceLifecycle } from '../core/service-registry.ts';
import { ServiceNames } from '../core/service-interfaces.ts';
import type { 
  IWriterQueue, 
  IngestionItem, 
  IKnowledgeStore, 
  StoreDocument 
} from '../core/interfaces/knowledge-interfaces.ts';

/**
 * Normalize a URL for deduplication and storage purposes.
 *
 * Strips trailing slashes, sorts query parameters, lowercases the hostname,
 * removes default ports, removes empty hash fragments, and removes
 * trailing `?` from URLs with empty query strings.
 *
 * Returns the original string unchanged if URL parsing fails.
 */
export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // Lowercase hostname (scheme already lowercase from URL constructor)
    parsed.hostname = parsed.hostname.toLowerCase();
    // Remove default ports
    if ((parsed.protocol === 'https:' && parsed.port === '443') ||
        (parsed.protocol === 'http:' && parsed.port === '80')) {
      parsed.port = '';
    }
    // Sort query parameters for consistent ordering
    parsed.searchParams.sort();
    // Remove empty hash
    if (parsed.hash === '#' || parsed.hash === '') {
      parsed.hash = '';
    }
    // Strip trailing slashes from pathname (URL constructor forces '/' for root)
    while (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    let result = parsed.toString();
    // URL constructor always produces 'https://host/' for root — strip that trailing slash
    if (result.endsWith('/')) {
      result = result.slice(0, -1);
    }
    return result;
  } catch {
    return url;
  }
}

function isConnectionRefused(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('ECONNREFUSED');
}

export type { IngestionItem };

export interface WriterQueueOptions {
  store: IKnowledgeStore;
  chunker?: Chunker;
}

/**
 * Validate URL format — rejects obviously malformed URLs from AI hallucinations.
 * Also provides basic SSRF defense-in-depth by rejecting internal network addresses.
 * FIX (Issues 3/4/8): This is the knowledge store's security boundary.
 */
export function validateUrl(url: string): boolean {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    // Only allow HTTP/HTTPS protocols
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const hostname = parsed.hostname.toLowerCase();
    // Must have a hostname
    if (!hostname) return false;
    // Reject localhost and loopback
    if (hostname === 'localhost' || hostname.endsWith('.localhost')) return false;
    // Reject IPv6 loopback, link-local, unique local, and IPv4-mapped
    if (hostname === '::1' || hostname === '[::1]') return false;
    if (hostname.startsWith('fe80:') || hostname.startsWith('[fe80:')) return false;
    if (hostname.startsWith('fc') || hostname.startsWith('[fc')) return false; // fc00::/7 unique local
    if (hostname.startsWith('fd') || hostname.startsWith('[fd')) return false; // fd00::/8 unique local
    if (hostname.startsWith('::ffff:') || hostname.startsWith('[::ffff:')) return false; // IPv4-mapped
    // Reject private/internal network ranges (SSRF defense-in-depth)
    if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|0\.|169\.254\.)/.test(hostname)) return false;
    // Reject hostnames without a public TLD
    if (hostname.endsWith('.local') || hostname.endsWith('.internal')) return false;
    return true;
  } catch {
    return false;
  }
}

export class WriterQueue implements IWriterQueue {
  readonly name = ServiceNames.WRITER_QUEUE;
  lifecycle = ServiceLifecycle.UNINITIALIZED;

  private queue: IngestionItem[] = [];
  private processing = false;
  private options: WriterQueueOptions;
  private drainResolvers: (() => void)[] = [];
  // FIX (#2): Per-URL lock map to prevent TOCTOU races when concurrent writers
  // ingest the same URL. Key is the normalized URL; value is the in-flight promise.
  private inflightByUrl = new Map<string, Promise<void>>();

  constructor(options: WriterQueueOptions) {
    this.options = options;
  }

  async initialize(): Promise<void> {
    this.lifecycle = ServiceLifecycle.INITIALIZED;
  }

  async dispose(): Promise<void> {
    await this.drain();
    this.lifecycle = ServiceLifecycle.DISPOSED;
  }

  enqueue(item: IngestionItem): void {
    this.queue.push(item);
    this.process().catch(err => {
      logger.error('[writer-queue] Error in process():', err);
    });
  }

  private async process(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      try {
        // FIX (#2): Chain per-URL to serialize concurrent ingests of the same URL.
        // process() already runs sequentially, so we chain only for the race case
        // where two enqueue() calls trigger concurrent process() calls.
        const urlKey = normalizeUrl(item.url);
        const prev = this.inflightByUrl.get(urlKey) ?? Promise.resolve();
        const inflight = prev.then(() => this._ingestInner(item));
        this.inflightByUrl.set(urlKey, inflight);
        try {
          await inflight;
        } finally {
          if (this.inflightByUrl.get(urlKey) === inflight) {
            this.inflightByUrl.delete(urlKey);
          }
        }
      } catch (err) {
        if (isConnectionRefused(err)) {
          logger.warn(`[writer-queue] Embedder unreachable for ${item.url}, retrying once after 2s...`);
          await new Promise(r => setTimeout(r, 2000));
          try {
            await this.ingest(item);
          } catch (retryErr) {
            logger.error(`[writer-queue] Retry failed for ${item.url}, dropping:`, retryErr);
          }
        } else {
          logger.error(`[writer-queue] Failed to ingest ${item.url}:`, err);
        }
      }
    }

    this.processing = false;
    
    // Notify all drain callers
    const resolvers = [...this.drainResolvers];
    this.drainResolvers = [];
    for (const resolve of resolvers) {
      resolve();
    }
  }

  private async ingest(item: IngestionItem): Promise<void> {
    const urlKey = normalizeUrl(item.url);
    const prev = this.inflightByUrl.get(urlKey) ?? Promise.resolve();
    const inflight = prev.then(() => this._ingestInner(item));
    this.inflightByUrl.set(urlKey, inflight);
    try {
      await inflight;
    } finally {
      if (this.inflightByUrl.get(urlKey) === inflight) {
        this.inflightByUrl.delete(urlKey);
      }
    }
  }

  private async _ingestInner(item: IngestionItem): Promise<void> {
    const incomingType = (item.metadata?.['ingestionType'] as string | undefined) ?? 'synthesis-description';

    if (!item.markdown) {
      logger.warn(`[writer-queue] Skipping ingest for ${item.url} — markdown is empty`);
      return;
    }

    // FIX (Issue 3/4): Validate URL format to prevent storing hallucinated/malformed URLs
    if (!validateUrl(item.url)) {
      logger.warn(`[writer-queue] Skipping ingest — URL failed validation: ${item.url}`);
      return;
    }

    // Normalize URL for consistent deduplication and storage.
    // The original URL is preserved in metadata for reference, but all
    // dedup checks and store operations use the normalized form.
    const normalizedUrl = normalizeUrl(item.url);

    const hash = createHash('sha256').update(item.markdown).update(item.content ?? '').digest('hex');

    if (this.options.store.isStoreClosed?.()) {
      logger.warn(`[writer-queue] Skipping ingest for ${normalizedUrl} — store is closing`);
      return;
    }

    // FIX (Issue 5): Add provenance metadata to distinguish verified vs unverified entries
    const hasContent = !!item.content;
    const provenanceCategory = hasContent ? 'scraped-verified' : 'description-unverified';
    const provenanceMeta = {
      provenance: provenanceCategory,
      hasContent,
      validatedAt: Date.now(),
    };

    // Dedup: check if we already have this exact URL+type with identical content.
    // findByUrl applies scope filtering, so this only dedupes within the
    // current project's visible scope (local workspace + global entries).
    const existing = await this.options.store.findByUrl(normalizedUrl);
    const sameType = existing.filter(c => c.metadata['ingestionType'] === incomingType);
    if (sameType.length > 0 && sameType[0]!.metadata['contentHash'] === hash) {
      logger.log(`[writer-queue] Skipping ${normalizedUrl} (${incomingType}) — content unchanged.`);
      return;
    }

    if (sameType.length > 0) {
      await this.options.store.deleteByUrlAndType(normalizedUrl, incomingType);
    }

    const rawChunks = this.options.chunker
      ? this.options.chunker.chunk(item.markdown)
      : [{ text: item.markdown, actual_overlap: 0 }];

    if (rawChunks.length === 0) return;

    const docs: StoreDocument[] = rawChunks.map((chunk, i) => ({
      url: normalizedUrl,
      text: chunk.text,
      content: i === 0 ? (item.content ?? undefined) : undefined,
      metadata: {
        ...(item.metadata || {}),
        // Preserve the original (pre-normalization) URL for debugging/display
        originalUrl: item.url !== normalizedUrl ? item.url : undefined,
        contentHash: hash,
        ingestionType: incomingType,
        ...provenanceMeta,
        chunkIndex: i,
        totalChunks: rawChunks.length,
      },
      timestamp: Date.now(),
    }));

    await this.options.store.addDocuments(docs);
  }

  async drain(): Promise<void> {
    // FIX (#7): Atomically check state AND register the resolver inside the
    // Promise constructor to prevent the race where process() finishes between
    // the check and new Promise().
    return new Promise<void>((resolve) => {
      if (!this.processing && this.queue.length === 0) {
        resolve();
        return;
      }
      this.drainResolvers.push(resolve);
    });
  }
}
