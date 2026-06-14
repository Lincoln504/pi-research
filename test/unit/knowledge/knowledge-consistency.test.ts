import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { normalizeUrl, validateUrl } from '../../../src/utils/url-utils.ts';
import { KnowledgeStore } from '../../../src/knowledge/store.ts';
import { WriterQueue } from '../../../src/knowledge/writer-queue.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('Knowledge Store & URL Consistency Integration', () => {
  const testDbDir = path.join(os.tmpdir(), `pi-test-db-${Date.now()}`);
  
  beforeEach(() => {
    if (fs.existsSync(testDbDir)) {
      fs.rmSync(testDbDir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(testDbDir)) {
      try { fs.rmSync(testDbDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('should normalize URLs consistently across writer and search', () => {
    const urls = [
      'http://example.com/',
      'https://example.com',
      'HTTPS://EXAMPLE.COM/PATH/',
      'https://example.com/path?b=2&a=1#hash',
    ];

    const normalized = urls.map(u => normalizeUrl(u));

    expect(normalized[0]!).toBe('https://example.com');
    expect(normalized[1]).toBe('https://example.com');
    expect(normalized[2]).toBe('https://example.com/PATH');
    expect(normalized[3]).toBe('https://example.com/path?a=1&b=2');
  });

  it('should validate URLs correctly (SSRF defense)', () => {
    expect(validateUrl('https://google.com')).toBe(true);
    expect(validateUrl('http://10.0.0.1')).toBe(false);
    expect(validateUrl('https://localhost')).toBe(false);
    expect(validateUrl('https://127.0.0.1')).toBe(false);
    expect(validateUrl('https://internal.local')).toBe(false);
    expect(validateUrl('not-a-url')).toBe(false);
  });

  it('should count unique projects efficiently in KnowledgeStore', async () => {
    // Mock embedder
    const mockEmbedder = {
      embed: vi.fn().mockResolvedValue(new Float32Array(384)),
      embedMany: vi.fn().mockResolvedValue([new Float32Array(384)]),
      getDimension: () => 384,
      isInitialized: () => true,
    };

    const store = new KnowledgeStore({ knowledgeMode: "project", dbDir: testDbDir,
      embedder: mockEmbedder as any,
      modelName: 'test-model',
      workspace: '/project/a',
      localEnabled: true,
      globalEnabled: true });

    await store.initialize();

    // Add some documents with different workspaces
    // Note: We bypass addDocuments to avoid needing a full writer queue for this simple count test
    // or we can use the writer queue to be more "integration-y".
    
    const writer = new WriterQueue({ store, chunker: null });
    await writer.initialize();

    await writer.enqueue({
      url: 'https://a.com',
      markdown: 'test a',
      metadata: { ingestionType: 'synthesis-description' }
    });
    
    // Switch workspace for the next one (simulating different project)
    // Actually KnowledgeStore's workspace is fixed at init. 
    // We can create a second store instance pointing to same DB but different workspace.
    
    const storeB = new KnowledgeStore({ knowledgeMode: "project", dbDir: testDbDir,
      embedder: mockEmbedder as any,
      modelName: 'test-model',
      workspace: '/project/b',
      localEnabled: true,
      globalEnabled: true });
    await storeB.initialize();
    const writerB = new WriterQueue({ store: storeB, chunker: null });
    await writerB.initialize();

    await writerB.enqueue({
      url: 'https://b.com',
      markdown: 'test b',
      metadata: { ingestionType: 'synthesis-description' }
    });

    await writer.drain();
    await writerB.drain();

    const counts = await store.countScoped();
    expect(counts.projects).toBe(2);
    expect(counts.local).toBe(1);
    
    await store.close();
    await storeB.close();
  });
});
