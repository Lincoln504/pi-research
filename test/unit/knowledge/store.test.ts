import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KnowledgeStore } from '../../../src/knowledge/store.ts';
import { Embedder } from '../../../src/knowledge/embedder.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import os from 'node:os';

// Mock Embedder
const mockEmbedder = {
  getDimension: vi.fn().mockReturnValue(384),
  embed: vi.fn().mockResolvedValue(new Float32Array(384)),
  embedMany: vi.fn().mockImplementation(async (texts: string[]) => texts.map(() => new Float32Array(384))),
  isInitialized: vi.fn().mockReturnValue(true),
} as unknown as Embedder;

describe('KnowledgeStore', () => {
  let store: KnowledgeStore;
  let testDbDir: string;

  beforeEach(async () => {
    testDbDir = path.join(os.tmpdir(), `pi-research-test-${Date.now()}`);
    store = new KnowledgeStore({
      dbDir: testDbDir,
      embedder: mockEmbedder,
      modelName: 'test-model',
    });
  });

  afterEach(async () => {
    try {
      await store.close();
    } finally {
      if (fs.existsSync(testDbDir)) {
        fs.rmSync(testDbDir, { recursive: true, force: true });
      }
      vi.clearAllMocks();
    }
  });

  it('should open and initialize a table', async () => {
    await store.open();
    expect(fs.existsSync(testDbDir)).toBe(true);
  });

  it('should insert and search documents', async () => {
    await store.open();
    const timestamp = Date.now();
    const doc = {
      url: 'https://example.com',
      text: 'Hello world',
      content: 'full page content here',
      metadata: { title: 'Test', ingestionType: 'synthesis-description' },
      timestamp: timestamp,
    };

    await store.addDocuments([doc]);

    const results = await store.search('hello', { limit: 1 });
    expect(results).toHaveLength(1);
    expect(results[0].url).toBe('https://example.com');
    expect(results[0].text).toBe('Hello world');
    expect(results[0].content).toBe('full page content here');
    expect(results[0].metadata.title).toBe('Test');
    expect(results[0].timestamp).toBe(timestamp);
  });

  it('should throw when addDocuments is called before open()', async () => {
    await expect(store.addDocuments([{
      url: 'https://example.com',
      text: 'test',
      metadata: {},
      timestamp: Date.now(),
    }])).rejects.toThrow('Store not open');
  });

  it('addDocuments with empty array returns without calling embedMany', async () => {
    await store.open();
    vi.mocked(mockEmbedder.embedMany).mockClear();
    await expect(store.addDocuments([])).resolves.toBeUndefined();
    expect(mockEmbedder.embedMany).not.toHaveBeenCalled();
  });

  it('addDocuments with synthesis-description type calls the embedder', async () => {
    await store.open();
    vi.mocked(mockEmbedder.embedMany).mockClear();
    await store.addDocuments([{
      url: 'https://example.com/desc',
      text: 'researcher description of the page',
      metadata: { ingestionType: 'synthesis-description', chunkIndex: 0 },
      timestamp: Date.now(),
    }]);
    expect(mockEmbedder.embedMany).toHaveBeenCalledOnce();
  });

  it('findByUrl returns only documents for the exact URL', async () => {
    await store.open();
    await store.addDocuments([
      { url: 'https://example.com/a', text: 'page A', metadata: { chunkIndex: 0 }, timestamp: Date.now() },
      { url: 'https://example.com/b', text: 'page B', metadata: { chunkIndex: 0 }, timestamp: Date.now() },
    ]);

    const results = await store.findByUrl('https://example.com/a');
    expect(results.length).toBeGreaterThan(0);
    expect(results.every(r => r.url === 'https://example.com/a')).toBe(true);
  });

  it('findByUrl returns empty array for URL with no documents', async () => {
    await store.open();
    const results = await store.findByUrl('https://nonexistent.example.com');
    expect(results).toEqual([]);
  });

  it('findByUrl handles URLs containing single quotes without throwing', async () => {
    await store.open();
    // This would break if SQL escaping is not applied
    await expect(store.findByUrl("https://example.com/it's-a-test")).resolves.toBeDefined();
  });

  it('deleteByUrl removes all chunks for a URL and leaves others intact', async () => {
    await store.open();
    await store.addDocuments([
      { url: 'https://example.com/target', text: 'chunk 1', metadata: { chunkIndex: 0 }, timestamp: Date.now() },
      { url: 'https://example.com/target', text: 'chunk 2', metadata: { chunkIndex: 1 }, timestamp: Date.now() },
      { url: 'https://example.com/other', text: 'other page', metadata: { chunkIndex: 0 }, timestamp: Date.now() },
    ]);

    await store.deleteByUrl('https://example.com/target');

    const deleted = await store.findByUrl('https://example.com/target');
    expect(deleted).toHaveLength(0);

    const remaining = await store.findByUrl('https://example.com/other');
    expect(remaining.length).toBeGreaterThan(0);
  });

  it('deleteByUrlAndType removes only chunks of the specified type and leaves the other type intact', async () => {
    await store.open();
    await store.addDocuments([
      { url: 'https://example.com/page', text: 'full page raw content', metadata: { chunkIndex: 0, ingestionType: 'raw-content' }, timestamp: Date.now() },
      { url: 'https://example.com/page', text: 'researcher description', metadata: { chunkIndex: 0, ingestionType: 'synthesis-description' }, timestamp: Date.now() },
    ]);

    await store.deleteByUrlAndType('https://example.com/page', 'synthesis-description');

    const remaining = await store.findByUrl('https://example.com/page');
    expect(remaining.every(r => r.metadata['ingestionType'] === 'raw-content')).toBe(true);
    expect(remaining.length).toBeGreaterThan(0);
  });

  it('rebuildDocument returns the content field from a synthesis-description row', async () => {
    await store.open();
    const fullPageContent = 'Hello world this is the full document content.';

    await store.addDocuments([{
      url: 'https://example.com/doc',
      text: 'researcher description of the page',
      content: fullPageContent,
      metadata: { ingestionType: 'synthesis-description' },
      timestamp: Date.now(),
    }]);

    const rebuilt = await store.rebuildDocument('https://example.com/doc');
    expect(rebuilt?.text).toBe(fullPageContent);
  });

  it('rebuildDocument returns null when synthesis-description row has no content field', async () => {
    await store.open();
    await store.addDocuments([{
      url: 'https://example.com/desc-only',
      text: 'researcher description',
      metadata: { ingestionType: 'synthesis-description' },
      timestamp: Date.now(),
    }]);

    const result = await store.rebuildDocument('https://example.com/desc-only');
    expect(result).toBeNull();
  });

  it('rebuildDocument returns null for unknown URL', async () => {
    await store.open();
    const result = await store.rebuildDocument('https://nonexistent.example.com');
    expect(result).toBeNull();
  });

  it('findRelevantUrls deduplicates URLs across multiple chunks from the same source', async () => {
    await store.open();
    // Insert two synthesis-description chunks from the same URL (these are what findRelevantUrls returns)
    await store.addDocuments([
      { url: 'https://example.com/dedup', text: 'first chunk of the document', metadata: { chunkIndex: 0, ingestionType: 'synthesis-description' }, timestamp: Date.now() },
      { url: 'https://example.com/dedup', text: 'second chunk of the document', metadata: { chunkIndex: 1, ingestionType: 'synthesis-description' }, timestamp: Date.now() },
      { url: 'https://example.com/other', text: 'a different document entirely', metadata: { chunkIndex: 0, ingestionType: 'synthesis-description' }, timestamp: Date.now() },
    ]);

    const urls = await store.findRelevantUrls('document chunk', { limit: 10 });

    // Result is an array of unique URLs — no duplicates
    const unique = new Set(urls);
    expect(unique.size).toBe(urls.length);
    // Both source URLs should appear
    expect(urls).toContain('https://example.com/dedup');
    expect(urls).toContain('https://example.com/other');
  });

  it('count() returns 0 before open and the number of documents after insertion', async () => {
    expect(await store.count()).toBe(0);
    await store.open();
    expect(await store.count()).toBe(0);
    await store.addDocuments([
      { url: 'https://example.com/a', text: 'doc a', metadata: { chunkIndex: 0 }, timestamp: Date.now() },
      { url: 'https://example.com/b', text: 'doc b', metadata: { chunkIndex: 0 }, timestamp: Date.now() },
    ]);
    expect(await store.count()).toBe(2);
  });

  it('rebuildFtsIndex resolves without error after documents are added', async () => {
    await store.open();
    await store.addDocuments([
      { url: 'https://example.com', text: 'test document', metadata: {}, timestamp: Date.now() },
    ]);
    await expect(store.rebuildFtsIndex()).resolves.toBeUndefined();
  });

  it('evictOldRecords removes documents older than the TTL on open()', async () => {
    await store.open();
    // Insert document with timestamp at epoch (definitely older than 30-day default TTL)
    await store.addDocuments([
      { url: 'https://example.com/old', text: 'old content', metadata: {}, timestamp: 1 },
    ]);
    const beforeClose = await store.findByUrl('https://example.com/old');
    expect(beforeClose.length).toBeGreaterThan(0);

    await store.close();

    // Re-open — evictOldRecords runs during open(), epoch record is evicted
    const newStore = new KnowledgeStore({
      dbDir: testDbDir,
      embedder: mockEmbedder,
      modelName: 'test-model',
    });
    await newStore.open();
    try {
      const afterEviction = await newStore.findByUrl('https://example.com/old');
      expect(afterEviction).toHaveLength(0);
    } finally {
      await newStore.close();
    }
  });

  it('should invalidate table if model changes', async () => {
    await store.open();
    
    // Add a document first to make the test meaningful
    const doc = {
      url: 'https://example.com',
      text: 'Hello world',
      metadata: { title: 'Test', ingestionType: 'synthesis-description' },
      timestamp: Date.now(),
    };
    await store.addDocuments([doc]);
    
    // Verify document exists before model change
    const resultsBefore = await store.search('hello', { limit: 1 });
    expect(resultsBefore).toHaveLength(1);
    
    await store.close();
    
    // Re-open with different model
    const newStore = new KnowledgeStore({
      dbDir: testDbDir,
      embedder: mockEmbedder,
      modelName: 'different-model',
    });
    await newStore.open();
    try {
      const results = await newStore.search('hello', { limit: 1 });
      expect(results).toHaveLength(0);
    } finally {
      await newStore.close();
    }
  });

  it('should clear all data', async () => {
    await store.open();
    const doc = {
      url: 'https://example.com/clear',
      text: 'Clear me',
      metadata: { title: 'Clear', ingestionType: 'synthesis-description' },
      timestamp: Date.now(),
    };
    await store.addDocuments([doc]);
    expect(await store.count()).toBe(1);

    await store.clear();
    expect(await store.count()).toBe(0);
    
    // Should still be able to add documents after clearing
    await store.addDocuments([doc]);
    expect(await store.count()).toBe(1);
  });
});
