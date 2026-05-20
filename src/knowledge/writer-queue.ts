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
  metadata?: Record<string, any>;
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
    const incomingType = (item.metadata?.['ingestionType'] as string | undefined) ?? 'raw-content';

    const existing = await this.options.store.findByUrl(item.url);

    // Scope dedup to same ingestionType — raw-content and synthesis-description
    // serve different purposes and must coexist independently for the same URL.
    const sameType = existing.filter(c => c.metadata['ingestionType'] === incomingType);
    if (sameType.length > 0 && sameType[0]!.metadata['contentHash'] === hash) {
      logger.log(`[writer-queue] Skipping ${item.url} (${incomingType}) — content unchanged.`);
      return;
    }

    // Delete only same-type stale chunks; preserve the other type.
    if (sameType.length > 0) {
      await this.options.store.deleteByUrlAndType(item.url, incomingType);
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
        ingestionType: incomingType, // Ensure this is always set for embedder-skip logic
        ...(item.metadata || {}),
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
