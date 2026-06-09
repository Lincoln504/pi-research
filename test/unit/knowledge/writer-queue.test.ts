import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { WriterQueue } from '../../../src/knowledge/writer-queue.ts';
import { KnowledgeStore } from '../../../src/knowledge/store.ts';

// Mock Store
const mockStore = {
  addDocuments: vi.fn().mockResolvedValue(undefined),
  findByUrl: vi.fn().mockResolvedValue([]),
  deleteByUrl: vi.fn().mockResolvedValue(undefined),
  deleteByUrlAndType: vi.fn().mockResolvedValue(undefined),
  isStoreClosed: vi.fn().mockReturnValue(false),
} as any;

describe('WriterQueue', () => {
  let queue: WriterQueue;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.addDocuments.mockResolvedValue(undefined);
    mockStore.findByUrl.mockResolvedValue([]);
    mockStore.deleteByUrl.mockResolvedValue(undefined);
    mockStore.deleteByUrlAndType.mockResolvedValue(undefined);
    mockStore.isStoreClosed.mockReturnValue(false);
    queue = new WriterQueue({ store: mockStore });
  });

  it('should process items in the queue with correct url and text', async () => {
    queue.enqueue({ url: 'https://test.com', markdown: 'description', metadata: { ingestionType: 'synthesis-description' } });
    await queue.drain();
    expect(mockStore.addDocuments).toHaveBeenCalledOnce();
    const docs = vi.mocked(mockStore.addDocuments).mock.calls[0][0];
    expect(docs[0].url).toBe('https://test.com');
    expect(docs[0].text).toBe('description');
  });

  it('should skip ingestion if markdown is empty', async () => {
    queue.enqueue({ url: 'https://test.com', markdown: '', metadata: { ingestionType: 'synthesis-description' } });
    await queue.drain();
    expect(mockStore.addDocuments).not.toHaveBeenCalled();
  });

  it('should store contentHash in document metadata', async () => {
    queue.enqueue({ url: 'https://test.com', markdown: 'description', metadata: { ingestionType: 'synthesis-description' } });
    await queue.drain();
    const docs = vi.mocked(mockStore.addDocuments).mock.calls[0][0];
    const expectedHash = createHash('sha256').update('description').update('').digest('hex');
    expect(docs[0].metadata.contentHash).toBe(expectedHash);
  });

  it('should store full page content on the document', async () => {
    queue.enqueue({
      url: 'https://test.com',
      markdown: 'description',
      content: 'full page markdown here',
      metadata: { ingestionType: 'synthesis-description' },
    });
    await queue.drain();
    const docs = vi.mocked(mockStore.addDocuments).mock.calls[0][0];
    expect(docs[0].content).toBe('full page markdown here');
  });

  it('raw-content items are written to the store (no special-case guard)', async () => {
    // The raw-content guard was removed: all ingestion types are now processed.
    // Nothing in production creates raw-content items, but if one is enqueued it
    // should be persisted rather than silently dropped.
    queue.enqueue({ url: 'https://test.com', markdown: 'full scraped page', metadata: { ingestionType: 'raw-content' } });
    await queue.drain();
    expect(mockStore.addDocuments).toHaveBeenCalled();
  });

  it('should deduplicate same content for matching ingestionType', async () => {
    const hash = createHash('sha256').update('description').update('').digest('hex');
    mockStore.findByUrl.mockResolvedValue([{
      url: 'https://test.com',
      text: 'description',
      metadata: { contentHash: hash, ingestionType: 'synthesis-description' },
      timestamp: Date.now(),
    }]);

    queue.enqueue({ url: 'https://test.com', markdown: 'description', metadata: { ingestionType: 'synthesis-description' } });
    await queue.drain();

    expect(mockStore.addDocuments).not.toHaveBeenCalled();
  });

  it('should re-ingest when content changes even if description is the same', async () => {
    const hash = createHash('sha256').update('description').update('old content').digest('hex');
    mockStore.findByUrl.mockResolvedValue([{
      url: 'https://test.com',
      text: 'description',
      metadata: { contentHash: hash, ingestionType: 'synthesis-description' },
      timestamp: Date.now(),
    }]);

    // Same description, different content
    queue.enqueue({
      url: 'https://test.com',
      markdown: 'description',
      content: 'new content',  // different from 'old content'
      metadata: { ingestionType: 'synthesis-description' },
    });
    await queue.drain();

    expect(mockStore.deleteByUrlAndType).toHaveBeenCalledWith('https://test.com', 'synthesis-description');
    expect(mockStore.addDocuments).toHaveBeenCalled();
  });

  it('drain() returns immediately when queue is empty and not processing', async () => {
    const start = Date.now();
    await queue.drain();
    expect(Date.now() - start).toBeLessThan(100);
  });

  it('drain() called multiple times while processing all resolve when queue empties', async () => {
    let unblock: () => void;
    mockStore.addDocuments.mockImplementationOnce(
      () => new Promise<void>(resolve => { unblock = resolve; }),
    );

    queue.enqueue({ url: 'https://test.com', markdown: 'description', metadata: { ingestionType: 'synthesis-description' } });
    const p1 = queue.drain();
    const p2 = queue.drain();

    await Promise.resolve();
    await Promise.resolve();
    // FIX: Extra microtick to allow the .then() chain in process() to reach addDocuments
    await Promise.resolve();
    unblock!();

    await Promise.all([p1, p2]);
    expect(mockStore.addDocuments).toHaveBeenCalledOnce();
  });

  it('continues processing remaining items when one addDocuments call rejects', async () => {
    mockStore.addDocuments
      .mockRejectedValueOnce(new Error('DB write failed'))
      .mockResolvedValue(undefined);

    queue.enqueue({ url: 'https://test.com/first', markdown: 'first', metadata: { ingestionType: 'synthesis-description' } });
    queue.enqueue({ url: 'https://test.com/second', markdown: 'second', metadata: { ingestionType: 'synthesis-description' } });
    await queue.drain();

    expect(mockStore.addDocuments).toHaveBeenCalledTimes(2);
  });

  it('items enqueued mid-process are consumed before drain resolves', async () => {
    let secondEnqueued = false;
    mockStore.addDocuments.mockImplementationOnce(async () => {
      queue.enqueue({ url: 'https://test.com/second', markdown: 'second', metadata: { ingestionType: 'synthesis-description' } });
      secondEnqueued = true;
    });

    queue.enqueue({ url: 'https://test.com/first', markdown: 'first', metadata: { ingestionType: 'synthesis-description' } });
    await queue.drain();

    expect(secondEnqueued).toBe(true);
    expect(mockStore.addDocuments).toHaveBeenCalledTimes(2);
  });

  it('should delete same-type rows and re-add when hash differs', async () => {
    const differentHash = createHash('sha256').update('different').digest('hex');
    vi.mocked(mockStore.findByUrl).mockResolvedValueOnce([{
      url: 'https://test.com',
      text: 'different description',
      metadata: { contentHash: differentHash, ingestionType: 'synthesis-description' },
      timestamp: Date.now(),
    }]);

    queue.enqueue({ url: 'https://test.com', markdown: 'description', metadata: { ingestionType: 'synthesis-description' } });
    await queue.drain();

    expect(mockStore.deleteByUrlAndType).toHaveBeenCalledWith('https://test.com', 'synthesis-description');
    expect(mockStore.addDocuments).toHaveBeenCalled();
  });
});
