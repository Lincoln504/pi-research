import { logger } from '../logger.ts';
import type { KnowledgeStore, StoreDocument } from './store.ts';
import type { Chunker } from './chunker.ts';
import { createHash } from 'node:crypto';

export interface WriterQueueOptions {
  store: KnowledgeStore;
  chunker: Chunker;
}

export interface IngestionItem {
  url: string;
  markdown: string;
}

export class WriterQueue {
  private queue: IngestionItem[] = [];
  private processing = false;
  private options: WriterQueueOptions;
  private drainPromise: Promise<void> | null = null;
  private drainResolver: (() => void) | null = null;

  constructor(options: WriterQueueOptions) {
    this.options = options;
  }

  enqueue(item: IngestionItem): void {
    this.queue.push(item);
    // Handle errors from fire-and-forget process() call to avoid unhandled rejections
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
        await this.ingest(item);
      } catch (err) {
        logger.error(`[writer-queue] Failed to ingest ${item.url}:`, err);
      }
    }

    this.processing = false;
    if (this.drainResolver) {
      this.drainResolver();
      this.drainResolver = null;
      this.drainPromise = null;
    }
  }

  private async ingest(item: IngestionItem): Promise<void> {
    const hash = createHash('sha256').update(item.markdown).digest('hex');
    
    // Check for deduplication using exact URL match (not semantic search)
    // Content hash is checked against the DB to prevent duplicate ingestion.
    const existing = await this.options.store.findByUrl(item.url);
    const firstExisting = existing[0];
    if (firstExisting && firstExisting.metadata['contentHash'] === hash) {
      logger.log(`[writer-queue] Skipping ${item.url} — content unchanged.`);
      return;
    }

    // Delete stale chunks before re-ingesting so old and new chunks don't mix
    if (firstExisting) {
      await this.options.store.deleteByUrl(item.url);
    }

    const chunks = this.options.chunker.chunk(item.markdown);
    const timestamp = Date.now();
    
    const docs: StoreDocument[] = chunks.map((chunk, i) => ({
      url: item.url,
      text: chunk.text,
      metadata: {
        chunkIndex: i,
        totalChunks: chunks.length,
        actualOverlap: chunk.actual_overlap,
        contentHash: hash,
      },
      timestamp: timestamp,
    }));

    await this.options.store.addDocuments(docs);
  }

  async drain(): Promise<void> {
    if (!this.processing && this.queue.length === 0) return;
    if (this.drainPromise) return this.drainPromise;

    this.drainPromise = new Promise<void>((resolve) => {
      this.drainResolver = resolve;
    });
    return this.drainPromise;
  }
}
