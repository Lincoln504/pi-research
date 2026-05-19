import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { WriterQueue } from '../../../src/knowledge/writer-queue.ts';
import { KnowledgeStore } from '../../../src/knowledge/store.ts';
import { Chunker } from '../../../src/knowledge/chunker.ts';

// Mock Store
const mockStore = {
  addDocuments: vi.fn().mockResolvedValue(undefined),
  findByUrl: vi.fn().mockResolvedValue([]),
  deleteByUrl: vi.fn().mockResolvedValue(undefined),
} as any;

// Mock Chunker
const mockChunker = {
  chunk: vi.fn().mockImplementation((text: string) => [{ text, actual_overlap: 0 }]),
} as unknown as Chunker;

describe('WriterQueue', () => {
  let queue: WriterQueue;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.addDocuments.mockResolvedValue(undefined);
    mockStore.findByUrl.mockResolvedValue([]);
    mockStore.deleteByUrl.mockResolvedValue(undefined);
    queue = new WriterQueue({
      store: mockStore,
      chunker: mockChunker,
    });
  });

  it('should process items in the queue with correct url and text', async () => {
    queue.enqueue({ url: 'https://test.com', markdown: 'content' });
    await queue.drain();
    expect(mockStore.addDocuments).toHaveBeenCalledOnce();
    const docs = vi.mocked(mockStore.addDocuments).mock.calls[0][0];
    expect(docs[0].url).toBe('https://test.com');
    expect(docs[0].text).toBe('content');
  });

  it('should store contentHash in document metadata', async () => {
    queue.enqueue({ url: 'https://test.com', markdown: 'content' });
    await queue.drain();
    const docs = vi.mocked(mockStore.addDocuments).mock.calls[0][0];
    const expectedHash = createHash('sha256').update('content').digest('hex');
    expect(docs[0].metadata.contentHash).toBe(expectedHash);
  });

  it('should deduplicate same content', async () => {
    const hash = createHash('sha256').update('content').digest('hex');
    
    mockStore.findByUrl.mockResolvedValue([{
      url: 'https://test.com',
      text: 'content',
      metadata: { contentHash: hash, chunkIndex: 0, totalChunks: 1 },
      timestamp: Date.now(),
    }]);
    
    queue.enqueue({ url: 'https://test.com', markdown: 'content' });
    await queue.drain();
    
    // Should NOT have called addDocuments if content hash matches
    expect(mockStore.addDocuments).not.toHaveBeenCalled();
  });

  it('drain() returns immediately when queue is empty and not processing', async () => {
    // No items enqueued — drain should resolve without waiting
    const start = Date.now();
    await queue.drain();
    expect(Date.now() - start).toBeLessThan(100);
  });

  it('drain() called multiple times while processing all resolve when queue empties', async () => {
    // Hold addDocuments open so both drain() calls are issued while processing is in-flight
    let unblock: () => void;
    mockStore.addDocuments.mockImplementationOnce(
      () => new Promise<void>(resolve => { unblock = resolve; }),
    );

    queue.enqueue({ url: 'https://test.com', markdown: 'content' });
    const p1 = queue.drain();
    const p2 = queue.drain();

    // Yield to the event loop so that findByUrl resolves and addDocuments is
    // called (assigning unblock) before we try to use it
    await Promise.resolve();
    unblock!();

    await Promise.all([p1, p2]);
    expect(mockStore.addDocuments).toHaveBeenCalledOnce();
  });

  it('continues processing remaining items when one addDocuments call rejects', async () => {
    mockStore.addDocuments
      .mockRejectedValueOnce(new Error('DB write failed'))
      .mockResolvedValue(undefined);

    queue.enqueue({ url: 'https://test.com/first', markdown: 'first' });
    queue.enqueue({ url: 'https://test.com/second', markdown: 'second' });
    await queue.drain();

    // Both items were attempted despite the first failing
    expect(mockStore.addDocuments).toHaveBeenCalledTimes(2);
  });

  it('items enqueued mid-process are consumed before drain resolves', async () => {
    let secondEnqueued = false;

    // Override addDocuments to enqueue a second item during the first ingest
    mockStore.addDocuments.mockImplementationOnce(async () => {
      queue.enqueue({ url: 'https://test.com/second', markdown: 'second' });
      secondEnqueued = true;
    });

    queue.enqueue({ url: 'https://test.com/first', markdown: 'first' });
    await queue.drain();

    expect(secondEnqueued).toBe(true);
    // The second item should also have been processed
    expect(mockStore.addDocuments).toHaveBeenCalledTimes(2);
  });

  it('should delete old chunks and re-add when hash differs', async () => {
    mockStore.addDocuments.mockClear();
    mockStore.deleteByUrl.mockClear();

    const differentHash = createHash('sha256').update('different').digest('hex');
    vi.mocked(mockStore.findByUrl).mockResolvedValueOnce([{
      url: 'https://test.com',
      text: 'different content',
      metadata: { contentHash: differentHash, chunkIndex: 0, totalChunks: 1 },
      timestamp: Date.now(),
    }]);

    queue.enqueue({ url: 'https://test.com', markdown: 'content' });
    await queue.drain();

    expect(mockStore.deleteByUrl).toHaveBeenCalledWith('https://test.com');
    expect(mockStore.addDocuments).toHaveBeenCalled();
  });
});
