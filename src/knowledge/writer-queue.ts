import { normalizeUrl, validateUrl } from '../utils/url-utils.ts';
import { isEmbedderUnreachable } from './embedder-utils.ts';
import { logger } from '../logger.ts';
import { metrics } from '../utils/metrics.ts';
import type { Chunker } from './chunker.ts';
import { createHash } from 'node:crypto';
import { ServiceLifecycle } from '../core/service-registry.ts';
import { ServiceNames } from '../core/service-interfaces.ts';
import type { 
  IWriterQueue, 
  IngestionItem,
  StoreDocument 
} from '../core/interfaces/knowledge-interfaces.ts';

interface WriterQueueOptions {
  store: {
    isStoreClosed?: () => boolean;
    findByUrl: (url: string) => Promise<StoreDocument[]>;
    deleteByUrlAndType: (url: string, type: string, olderThan?: number) => Promise<void>;
    addDocuments: (docs: StoreDocument[]) => Promise<void>;
    /** Revalidation touch for the content-unchanged skip (see that path). Optional
     *  so lightweight test doubles need not implement it. */
    touchByUrlAndType?: (url: string, type: string, generationTs: number, newTs: number) => Promise<void>;
  };
  chunker: Chunker | null;
}

/** Bounded window for draining the writer queue during dispose/shutdown. Kept well
 *  under the global SHUTDOWN_TIMEOUT_MS (8s) so LanceDB close and the browser orphan
 *  sweep still get their share of the teardown budget. */
const DRAIN_DISPOSE_TIMEOUT_MS = 5_000;

function isNoSpace(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  const msg = err instanceof Error ? err.message : String(err);
  return code === 'ENOSPC' || msg.includes('ENOSPC') || msg.toLowerCase().includes('no space left');
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
    // Bound the drain so a large burst enqueued right before shutdown (or a hung
    // embed) can't consume the whole global SHUTDOWN_TIMEOUT_MS budget — which is
    // shared with LanceDB close and the browser orphan sweep. On timeout we proceed
    // and account for the un-persisted items rather than hanging teardown.
    await this.drain(DRAIN_DISPOSE_TIMEOUT_MS);
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

    // try/finally around the whole drain: the latch and the drain notification used
    // to sit on the normal exit path only. Anything escaping the loop — including
    // from the catch block below, which itself awaits and logs — left `processing`
    // stuck true forever: no further item would ever be ingested, drain() would never
    // resolve, and dispose() would burn its full timeout on every later shutdown.
    // enqueue() swallows this promise's rejection, so the wedge was silent.
    try {
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
          if (isEmbedderUnreachable(err)) {
            logger.warn(`[writer-queue] Embedder unreachable for ${item.url}, retrying once after 2s...`);
            await new Promise(r => setTimeout(r, 2000));
            try {
              await this.ingest(item);
            } catch (retryErr) {
              logger.error(`[writer-queue] Retry failed for ${item.url}, dropping:`, retryErr);
              metrics.increment('knowledge_ingest_dropped_total', 1, { reason: 'embedder_unreachable' });
            }
          } else if (isNoSpace(err)) {
            logger.error(`[writer-queue] ENOSPC: disk full — dropping ${item.url}. Free up disk space to resume knowledge ingestion.`);
            metrics.increment('knowledge_ingest_dropped_total', 1, { reason: 'enospc' });
          } else {
            logger.error(`[writer-queue] Failed to ingest ${item.url}:`, err);
            metrics.increment('knowledge_ingest_dropped_total', 1, { reason: 'ingest_error' });
          }
        }
      }
    } finally {
      this.processing = false;

      // Notify all drain callers
      const resolvers = [...this.drainResolvers];
      this.drainResolvers = [];
      for (const resolve of resolvers) {
        resolve();
      }
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
    // Compared against the NEWEST generation, not row order: after a failed prune
    // two generations coexist and findByUrl's order is arbitrary — matching the
    // OLD generation's hash would skip the refresh with the duplicates in place.
    const existing = await this.options.store.findByUrl(normalizedUrl);
    const sameType = existing.filter(c => c.metadata['ingestionType'] === incomingType);
    if (sameType.length > 0) {
      const newestTs = Math.max(...sameType.map(d => Number(d.timestamp) || 0));
      const newest = sameType.find(d => (Number(d.timestamp) || 0) === newestTs)!;
      if (newest.metadata['contentHash'] === hash) {
        // Content unchanged vs the current generation — but a prior failed prune
        // may still have left older generations behind, and with stable content
        // this skip is the only code that ever looks at this URL again. Collect
        // them now instead of preserving the duplicates forever.
        if (sameType.some(d => (Number(d.timestamp) || 0) < newestTs)) {
          await this.options.store.deleteByUrlAndType(normalizedUrl, incomingType, newestTs).catch((err) => {
            logger.warn(`[writer-queue] Sweeping superseded duplicates for ${normalizedUrl} (${incomingType}) failed:`, err);
            metrics.increment('knowledge_ingest_stale_prune_failed_total', 1);
          });
        }
        // The content was just re-fetched and verified byte-identical — record
        // that as freshness. Without this touch, a stable page's timestamp never
        // moved: the serve-age gate treated it as permanently stale (live scrape
        // every run) and TTL eviction eventually deleted a revalidated entry.
        //
        // Re-check the newest generation first: a CONCURRENT process may have
        // ingested changed content for this url+type since our dedup read, and
        // stamping our (now-old) generation with a later timestamp would make the
        // stale rows outrank the genuinely newer ones. The touch predicate is
        // pinned to `timestamp = newestTs`, so the residual window is only the
        // gap between this re-read and the update — self-healing on the next
        // real scrape either way.
        if (this.options.store.touchByUrlAndType) {
          try {
            const recheck = (await this.options.store.findByUrl(normalizedUrl))
              .filter(c => c.metadata['ingestionType'] === incomingType);
            const stillNewest = recheck.length > 0
              && Math.max(...recheck.map(d => Number(d.timestamp) || 0)) === newestTs;
            if (stillNewest) {
              await this.options.store.touchByUrlAndType(normalizedUrl, incomingType, newestTs, Date.now());
            }
          } catch (err) {
            logger.warn(`[writer-queue] Timestamp refresh for unchanged ${normalizedUrl} (${incomingType}) failed:`, err);
          }
        }
        logger.log(`[writer-queue] Skipping ${normalizedUrl} (${incomingType}) — content unchanged.`);
        return;
      }
    }

    const rawChunks = this.options.chunker
      ? this.options.chunker.chunk(item.markdown)
      : [{ text: item.markdown, actual_overlap: 0 }];

    if (rawChunks.length === 0) return;

    // Single timestamp shared by every chunk of this write: it is both the row's
    // recency value and the boundary used to prune the rows this write replaces.
    const insertedAt = Date.now();

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
      timestamp: insertedAt,
    }));

    // Write the replacement BEFORE removing what it replaces. Deleting first made
    // the refresh destructive: addDocuments can fail (embedder unreachable, ENOSPC,
    // store closing mid-write) and the perfectly good previous entry was already
    // gone, so a failed refresh left the URL with no entry at all rather than a
    // stale one. In this order a failure leaves the old entry intact and the retry
    // simply tries again.
    await this.options.store.addDocuments(docs);

    if (sameType.length > 0) {
      // Prune only rows older than this write, so the delete cannot take the rows
      // just inserted. Failing here leaves duplicate chunks — visible but harmless,
      // and cleaned up by the next successful ingest of this URL — which is a far
      // better outcome than throwing away a write that already succeeded.
      await this.options.store.deleteByUrlAndType(normalizedUrl, incomingType, insertedAt).catch((err) => {
        logger.warn(`[writer-queue] Replacement for ${normalizedUrl} (${incomingType}) is stored, but pruning the superseded chunks failed; duplicates remain until the next refresh:`, err);
        metrics.increment('knowledge_ingest_stale_prune_failed_total', 1);
      });
    }
  }

  async drain(timeoutMs?: number): Promise<void> {
    // FIX (#7): Atomically check state AND register the resolver inside the
    // Promise constructor to prevent the race where process() finishes between
    // the check and new Promise().
    return new Promise<void>((resolve) => {
      if (!this.processing && this.queue.length === 0) {
        resolve();
        return;
      }
      // Optional bounded drain: if the queue doesn't empty within timeoutMs, resolve
      // anyway so a caller (shutdown) isn't held hostage by a slow/hung embed. Items
      // still queued at the deadline are counted as dropped (best-effort — a few may
      // still land as process() finishes, so the metric is a conservative upper bound).
      // These are re-scrapable cache entries, not primary user data.
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve();
      };
      this.drainResolvers.push(done);
      if (timeoutMs && timeoutMs > 0) {
        timer = setTimeout(() => {
          const remaining = this.queue.length + (this.processing ? 1 : 0);
          logger.warn(`[writer-queue] drain timed out after ${timeoutMs}ms with ~${remaining} item(s) not yet persisted; proceeding with shutdown.`);
          if (remaining > 0) {
            metrics.increment('knowledge_ingest_dropped_total', remaining, { reason: 'drain_timeout' });
          }
          // Detach our resolver so a later process() completion doesn't call it again
          // (harmless via the settled guard, but keeps drainResolvers from leaking).
          const idx = this.drainResolvers.indexOf(done);
          if (idx !== -1) this.drainResolvers.splice(idx, 1);
          done();
        }, timeoutMs);
        timer.unref?.();
      }
    });
  }
}
