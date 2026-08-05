import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { WriterQueue } from '../../../src/knowledge/writer-queue.ts';


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
    queue = new WriterQueue({ store: mockStore, chunker: null });
  });

  it('should process items in the queue with correct url and text', async () => {
    queue.enqueue({ url: 'https://test.com', markdown: 'description', metadata: { ingestionType: 'synthesis-description' } });
    await queue.drain();
    expect(mockStore.addDocuments).toHaveBeenCalledOnce();
    const docs = vi.mocked(mockStore.addDocuments).mock.calls[0][0];
    expect(docs[0]!.url).toBe('https://test.com');
    expect(docs[0]!.text).toBe('description');
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
    expect(docs[0]!.metadata.contentHash).toBe(expectedHash);
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
    expect(docs[0]!.content).toBe('full page markdown here');
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

    expect(mockStore.addDocuments).toHaveBeenCalled();
    // The superseded rows are pruned with an `olderThan` boundary equal to the new
    // rows' timestamp, so the prune cannot remove what was just written.
    const [url, type, olderThan] = vi.mocked(mockStore.deleteByUrlAndType).mock.calls[0]!;
    expect(url).toBe('https://test.com');
    expect(type).toBe('synthesis-description');
    const written = vi.mocked(mockStore.addDocuments).mock.calls[0]![0] as Array<{ timestamp: number }>;
    expect(olderThan).toBe(written[0]!.timestamp);
  });

  it('writes the replacement BEFORE pruning what it replaces', async () => {
    // Deleting first made a refresh destructive: if addDocuments then failed
    // (embedder unreachable, ENOSPC, store closing) the perfectly good previous
    // entry was already gone, so a failed refresh left the URL with nothing at all.
    const order: string[] = [];
    vi.mocked(mockStore.addDocuments).mockImplementation(async () => { order.push('add'); });
    vi.mocked(mockStore.deleteByUrlAndType).mockImplementation(async () => { order.push('delete'); });
    vi.mocked(mockStore.findByUrl).mockResolvedValueOnce([{
      url: 'https://test.com',
      text: 'stale description',
      metadata: { contentHash: 'a-different-hash', ingestionType: 'synthesis-description' },
      timestamp: Date.now(),
    }]);

    queue.enqueue({ url: 'https://test.com', markdown: 'description', metadata: { ingestionType: 'synthesis-description' } });
    await queue.drain();

    expect(order).toEqual(['add', 'delete']);
  });

  it('keeps the stored replacement when pruning the superseded rows fails', async () => {
    // The write already succeeded; a failed prune leaves duplicates (harmless, and
    // cleaned up by the next refresh) and must NOT be reported as a dropped ingest.
    vi.mocked(mockStore.deleteByUrlAndType).mockRejectedValueOnce(new Error('lance commit conflict'));
    vi.mocked(mockStore.findByUrl).mockResolvedValueOnce([{
      url: 'https://test.com',
      text: 'stale description',
      metadata: { contentHash: 'a-different-hash', ingestionType: 'synthesis-description' },
      timestamp: Date.now(),
    }]);

    queue.enqueue({ url: 'https://test.com', markdown: 'description', metadata: { ingestionType: 'synthesis-description' } });
    await expect(queue.drain()).resolves.toBeUndefined();

    expect(mockStore.addDocuments).toHaveBeenCalled();
  });

  it('drain() resolves without touching the store when the queue is empty', async () => {
    // An empty, idle queue must resolve drain() without doing any ingest work —
    // assert observable behaviour (no store interaction) rather than wall-clock.
    await expect(queue.drain()).resolves.toBeUndefined();
    expect(mockStore.addDocuments).not.toHaveBeenCalled();
    expect(mockStore.findByUrl).not.toHaveBeenCalled();
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

  it('drops item and logs error on ENOSPC without crashing the queue', async () => {
    // ENOSPC must not propagate to the caller; remaining items must still process
    mockStore.addDocuments
      .mockRejectedValueOnce(Object.assign(new Error('No space left on device'), { code: 'ENOSPC' }))
      .mockResolvedValue(undefined);

    queue.enqueue({ url: 'https://test.com/full-disk', markdown: 'doc1', metadata: { ingestionType: 'synthesis-description' } });
    queue.enqueue({ url: 'https://test.com/after', markdown: 'doc2', metadata: { ingestionType: 'synthesis-description' } });
    await queue.drain();

    // Second item must still be processed despite first failing with ENOSPC
    expect(mockStore.addDocuments).toHaveBeenCalledTimes(2);
  });

  it('retries once on ECONNREFUSED before dropping the item', async () => {
    vi.useFakeTimers();

    let callCount = 0;
    mockStore.addDocuments.mockImplementation(async () => {
      callCount++;
      // First two calls (original + retry) throw ECONNREFUSED; third succeeds
      if (callCount <= 2) throw new Error('ECONNREFUSED connect to 127.0.0.1:8080');
    });

    queue.enqueue({ url: 'https://test.com/retry', markdown: 'retried doc', metadata: { ingestionType: 'synthesis-description' } });

    // Start processing
    const drainP = queue.drain();
    // Allow the first ECONNREFUSED to be thrown and the 2s retry timer to be registered
    await vi.runAllTimersAsync();
    await drainP;

    // addDocuments called at least twice (original attempt + one retry)
    expect(mockStore.addDocuments.mock.calls.length).toBeGreaterThanOrEqual(2);

    vi.useRealTimers();
  });

  it('serializes concurrent ingests of the same URL via per-URL lock', async () => {
    const order: string[] = [];
    let unblockFirst: () => void;
    const firstBlocked = new Promise<void>(resolve => { unblockFirst = resolve; });

    mockStore.addDocuments.mockImplementationOnce(async () => {
      order.push('first-start');
      await firstBlocked;
      order.push('first-end');
    });
    mockStore.addDocuments.mockImplementationOnce(async () => {
      order.push('second-start');
    });

    // Queue both items for the same URL
    queue.enqueue({ url: 'https://same.com/url', markdown: 'first version', metadata: { ingestionType: 'synthesis-description' } });
    queue.enqueue({ url: 'https://same.com/url', markdown: 'second version', metadata: { ingestionType: 'synthesis-description' } });

    // Let first item begin processing (it will block)
    await Promise.resolve();
    await Promise.resolve();

    // Unblock the first item
    unblockFirst!();
    await queue.drain();

    // Both ran; first must complete entirely before second starts
    expect(order).toEqual(['first-start', 'first-end', 'second-start']);
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

    expect(mockStore.deleteByUrlAndType).toHaveBeenCalledWith(
      'https://test.com',
      'synthesis-description',
      expect.any(Number),
    );
    expect(mockStore.addDocuments).toHaveBeenCalled();
  });
});
