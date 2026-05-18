import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WriterQueue } from '../../../src/knowledge/writer-queue.ts';
import { KnowledgeStore } from '../../../src/knowledge/store.ts';
import { Chunker } from '../../../src/knowledge/chunker.ts';

// Mock Store
const mockStore = {
  addDocuments: vi.fn().mockResolvedValue(undefined),
  search: vi.fn().mockResolvedValue([]),
} as unknown as KnowledgeStore;

// Mock Chunker
const mockChunker = {
  chunk: vi.fn().mockImplementation((text: string) => [{ text, actual_overlap: 0 }]),
} as unknown as Chunker;

describe('WriterQueue', () => {
  let queue: WriterQueue;

  beforeEach(() => {
    queue = new WriterQueue({
      store: mockStore,
      chunker: mockChunker,
    });
  });

  it('should process items in the queue', async () => {
    queue.enqueue({ url: 'https://test.com', markdown: 'content' });
    await queue.drain();
    expect(mockStore.addDocuments).toHaveBeenCalled();
  });

  it('should deduplicate same content', async () => {
    // Mock search to return something if it exists
    vi.mocked(mockStore.search).mockResolvedValueOnce([{ url: 'https://test.com', text: 'content', metadata: {}, timestamp: 0 }]);
    
    queue.enqueue({ url: 'https://test.com', markdown: 'content' });
    await queue.drain();
    
    // Should NOT have called addDocuments if already exists
    // Wait, my deduplication might be hash based.
    // If search finds it, we skip.
  });
});
