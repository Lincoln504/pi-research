import { logger } from '../logger.ts';
import type { KnowledgeStore, StoreDocument } from './store.ts';
import { createHash } from 'node:crypto';

export interface WriterQueueOptions {
  store: KnowledgeStore;
}

export interface IngestionItem {
  url: string;
  markdown: string;
  content?: string;
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
    const incomingType = (item.metadata?.['ingestionType'] as string | undefined) ?? 'synthesis-description';

    // Raw-content is no longer persisted — content is stored on synthesis-description rows.
    if (incomingType === 'raw-content') return;

    const hash = createHash('sha256').update(item.markdown).digest('hex');

    if (this.options.store.isStoreClosed()) {
      logger.warn(`[writer-queue] Skipping ingest for ${item.url} — store is closing`);
      return;
    }

    const existing = await this.options.store.findByUrl(item.url);
    const sameType = existing.filter(c => c.metadata['ingestionType'] === incomingType);
    if (sameType.length > 0 && sameType[0]!.metadata['contentHash'] === hash) {
      logger.log(`[writer-queue] Skipping ${item.url} (${incomingType}) — content unchanged.`);
      return;
    }

    if (sameType.length > 0) {
      await this.options.store.deleteByUrlAndType(item.url, incomingType);
    }

    const doc: StoreDocument = {
      url: item.url,
      text: item.markdown,
      content: item.content,
      metadata: {
        contentHash: hash,
        ingestionType: incomingType,
        ...(item.metadata || {}),
      },
      timestamp: Date.now(),
    };

    await this.options.store.addDocuments([doc]);
  }

  async drain(): Promise<void> {
    if (!this.processing && this.queue.length === 0) return;
    if (this.drainPromise) return this.drainPromise;

    this.drainPromise = new Promise<void>((resolve) => {
      this.drainResolver = resolve;
    });

    if (!this.processing && this.queue.length === 0) {
      this.drainResolver!();
      this.drainResolver = null;
      this.drainPromise = null;
      return;
    }

    return this.drainPromise;
  }
}
