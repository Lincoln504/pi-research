import { logger } from '../logger.ts';
import type { KnowledgeStore } from './store.ts';
import type { StoreDocument } from './store-types.ts';
import type { Chunker } from './chunker.ts';
import { createHash } from 'node:crypto';
import { ServiceLifecycle } from '../core/service-registry.ts';
import { ServiceNames } from '../core/interfaces/service-names.ts';
import type { IWriterQueue } from '../core/interfaces/knowledge-interfaces.ts';

export interface WriterQueueOptions {
  store: KnowledgeStore;
  chunker?: Chunker;
}

export interface IngestionItem {
  url: string;
  markdown: string;
  content?: string;
  metadata?: Record<string, any>;
}

export class WriterQueue implements IWriterQueue {
  readonly name = ServiceNames.WRITER_QUEUE;
  lifecycle = ServiceLifecycle.UNINITIALIZED;

  private queue: IngestionItem[] = [];
  private processing = false;
  private options: WriterQueueOptions;
  private drainPromise: Promise<void> | null = null;
  private drainResolver: (() => void) | null = null;

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

    const rawChunks = this.options.chunker
      ? this.options.chunker.chunk(item.markdown)
      : [{ text: item.markdown, actual_overlap: 0 }];

    if (rawChunks.length === 0) return;

    const docs: StoreDocument[] = rawChunks.map((chunk, i) => ({
      url: item.url,
      text: chunk.text,
      content: i === 0 ? (item.content ?? undefined) : undefined,
      metadata: {
        ...(item.metadata || {}),
        contentHash: hash,
        ingestionType: incomingType,
        chunkIndex: i,
        totalChunks: rawChunks.length,
      },
      timestamp: Date.now(),
    }));

    await this.options.store.addDocuments(docs);
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
