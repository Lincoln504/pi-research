import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { KnowledgeStore } from '../../../src/knowledge/store.ts';
import { BM25_TABLE_NAME } from '../../../src/knowledge/store-schema.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import os from 'node:os';

/**
 * BM25 (lexical) retrieval mode tests.
 *
 * These run against REAL LanceDB with embedder: null and retrieval: 'bm25' —
 * the exact shape a bm25-only installation uses. No embedding model exists in
 * these tests at all: persistence and retrieval must work purely on the
 * Tantivy FTS/BM25 engine.
 */
describe('KnowledgeStore — bm25 (lexical) retrieval mode', () => {
  let store: KnowledgeStore;
  let testDbDir: string;

  beforeEach(() => {
    testDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-research-bm25-'));
    store = new KnowledgeStore({
      dbDir: testDbDir,
      embedder: null,
      retrieval: 'bm25',
      modelName: 'none',
      knowledgeMode: 'project',
    });
  });

  afterEach(async () => {
    try {
      await store.close();
    } finally {
      if (fs.existsSync(testDbDir)) {
        fs.rmSync(testDbDir, { recursive: true, force: true });
      }
    }
  });

  const doc = (url: string, text: string, content?: string, metadata: Record<string, any> = {}) => ({
    url,
    text,
    content,
    metadata: { ingestionType: 'synthesis-description', ...metadata },
    timestamp: Date.now(),
  });

  it('persists and retrieves findings with NO embedder — pure lexical round-trip', async () => {
    await store.open();
    await store.addDocuments([
      doc('https://example.com/lance', 'LanceDB is a vector database with full-text search'),
    ]);

    const results = await store.search('LanceDB full-text search', { limit: 5 });
    expect(results).toHaveLength(1);
    expect(results[0]!.url).toBe('https://example.com/lance');
    expect(results[0]!.metadata['ingestionType']).toBe('synthesis-description');
  });

  it('ranks a term-matching document above a non-matching one (BM25 ranking sanity)', async () => {
    await store.open();
    await store.addDocuments([
      doc('https://example.com/on-topic', 'BM25 ranking in LanceDB full-text search explained'),
      doc('https://example.com/off-topic', 'A recipe for sourdough bread and pizza dough'),
    ]);

    const results = await store.search('BM25 full-text search ranking', { limit: 2 });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.url).toBe('https://example.com/on-topic');
  });

  it('matches the full article body in the content column, not just the description', async () => {
    await store.open();
    await store.addDocuments([
      doc(
        'https://example.com/article',
        'A short summary about databases',
        'The full article body mentions quantumchromodynamics in passing, deep in the page.',
      ),
    ]);

    const results = await store.search('quantumchromodynamics', { limit: 5 });
    expect(results).toHaveLength(1);
    expect(results[0]!.url).toBe('https://example.com/article');
  });

  it('returns no results for a query matching nothing (instant miss)', async () => {
    await store.open();
    await store.addDocuments([doc('https://example.com/a', 'some text about databases')]);
    const results = await store.search('zzzqxv nonexistentterm', { limit: 5 });
    expect(results).toHaveLength(0);
  });

  it('respects project scope isolation — rows from another workspace are invisible', async () => {
    await store.open();
    await store.addDocuments([doc('https://example.com/mine', 'database internals and storage engines')]);
    store.close();

    // A store scoped to a DIFFERENT workspace must not see this project's rows.
    const other = new KnowledgeStore({
      dbDir: testDbDir,
      embedder: null,
      retrieval: 'bm25',
      modelName: 'none',
      knowledgeMode: 'project',
      workspace: '/some/other/workspace',
    });
    try {
      await other.open();
      const results = await other.search('database storage engines', { limit: 5 });
      expect(results).toHaveLength(0);
    } finally {
      await other.close();
    }
  });

  it('global mode rows are visible to global scope; a project store in a DIFFERENT workspace does not see them', async () => {
    // Global store writes a global row (from its own cwd — the default workspace).
    const global = new KnowledgeStore({
      dbDir: testDbDir,
      embedder: null,
      retrieval: 'bm25',
      modelName: 'none',
      knowledgeMode: 'global',
    });
    await global.open();
    await global.addDocuments([doc('https://example.com/shared', 'shared knowledge about compilers')]);
    await global.close();

    // The global scope sees it back.
    const global2 = new KnowledgeStore({
      dbDir: testDbDir,
      embedder: null,
      retrieval: 'bm25',
      modelName: 'none',
      knowledgeMode: 'global',
    });
    await global2.open();
    const globalResults = await global2.search('shared knowledge compilers', { limit: 5 });
    expect(globalResults).toHaveLength(1);
    await global2.close();

    // A project store scoped to a DIFFERENT workspace must not see it
    // (project filter matches on the workspace column).
    const other = new KnowledgeStore({
      dbDir: testDbDir,
      embedder: null,
      retrieval: 'bm25',
      modelName: 'none',
      knowledgeMode: 'project',
      workspace: '/some/other/workspace',
    });
    try {
      await other.open();
      const results = await other.search('shared knowledge compilers', { limit: 5 });
      expect(results).toHaveLength(0);
    } finally {
      await other.close();
    }
  });

  it('only serves synthesis-description rows to search (other ingestion types are storage-only)', async () => {
    await store.open();
    await store.addDocuments([
      doc('https://example.com/searchable', 'searchable synthesis description'),
    ]);
    // Write a raw (non-searchable) row directly via the same add path but a
    // different ingestion type.
    await store.addDocuments([doc('https://example.com/link', 'some link description', undefined, { ingestionType: 'link-description' })]);

    const results = await store.search('searchable synthesis', { limit: 10 });
    expect(results.map(r => r.url)).toEqual(['https://example.com/searchable']);
  });

  it('findRelevantUrls returns the StoreUrlEntry shape with provenance and dedupes URLs', async () => {
    await store.open();
    await store.addDocuments([
      doc('https://example.com/dup', 'compiler design notes', undefined, { description: 'A verified description' }),
    ]);

    const entries = await store.findRelevantUrls('compiler design', { limit: 20 });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.url).toBe('https://example.com/dup');
    expect(entries[0]!.description).toContain('A verified description');
    expect(entries[0]!.provenance).toContain('Local Project');
  });

  it('exportForWeb omits the vector field (there is no embedding to export)', async () => {
    await store.open();
    await store.addDocuments([
      doc('https://example.com/export', 'exportable summary', undefined, { description: 'short summary' }),
    ]);

    const outPath = path.join(testDbDir, 'export.json');
    await store.exportForWeb(outPath);
    const exported = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
    expect(exported).toHaveLength(1);
    expect(exported[0]!['url']).toBe('https://example.com/export');
    expect(exported[0]!['v']).toBeUndefined();
    expect(exported[0]!['m']!['d']).toBe('short summary');
  });

  it('uses its own table (knowledge-bm25) and manifest key, leaving vector stores untouched', async () => {
    // 1. A VECTOR store exists first (the pre-existing user state).
    const vectorStore = new KnowledgeStore({
      dbDir: testDbDir,
      embedder: {
        getDimension: () => 384,
        getOriginalDevice: () => null,
        getDevice: () => null,
        setDimension: () => {},
        isInitialized: () => true,
        embed: async () => new Float32Array(384),
        embedMany: async (texts: string[]) => texts.map(() => new Float32Array(384)),
        dispose: async () => {},
      } as any,
      modelName: 'Xenova/all-MiniLM-L6-v2',
      knowledgeMode: 'project',
    });
    await vectorStore.open();
    await vectorStore.addDocuments([doc('https://example.com/vector-row', 'a vector-mode finding about embeddings')]);
    await vectorStore.close();

    // 2. The bm25 store shares the SAME dbDir.
    await store.open();
    await store.addDocuments([doc('https://example.com/bm25-row', 'a lexical-mode finding about BM25')]);

    // The lexical table exists alongside the vector table.
    const manifest = JSON.parse(fs.readFileSync(path.join(testDbDir, 'store-manifest.json'), 'utf-8'));
    expect(manifest['activeBm25TableName']).toBe(BM25_TABLE_NAME);
    expect(manifest['activeTableName']).toBe('knowledge');

    // Each mode sees ONLY its own row.
    const bm25Results = await store.search('lexical BM25 finding', { limit: 10 });
    expect(bm25Results.map(r => r.url)).toEqual(['https://example.com/bm25-row']);
    await store.close();

    // 3. Switching back to vector mode still works, unchanged, no migration.
    const vectorAgain = new KnowledgeStore({
      dbDir: testDbDir,
      embedder: {
        getDimension: () => 384,
        getOriginalDevice: () => null,
        getDevice: () => null,
        setDimension: () => {},
        isInitialized: () => true,
        embed: async () => new Float32Array(384),
        embedMany: async (texts: string[]) => texts.map(() => new Float32Array(384)),
        dispose: async () => {},
      } as any,
      modelName: 'Xenova/all-MiniLM-L6-v2',
      knowledgeMode: 'project',
    });
    await vectorAgain.open();
    const vectorResults = await vectorAgain.search('embeddings finding', { limit: 10 });
    expect(vectorResults.map(r => r.url)).toEqual(['https://example.com/vector-row']);
    await vectorAgain.close();
  });

  it('re-opens its existing bm25 table across restarts (persistence across runs)', async () => {
    await store.open();
    await store.addDocuments([doc('https://example.com/persist', 'persistent lexical knowledge about parsing')]);
    await store.close();

    const reopened = new KnowledgeStore({
      dbDir: testDbDir,
      embedder: null,
      retrieval: 'bm25',
      modelName: 'none',
      knowledgeMode: 'project',
    });
    try {
      await reopened.open();
      const results = await reopened.search('persistent lexical parsing', { limit: 5 });
      expect(results).toHaveLength(1);
      expect(results[0]!.url).toBe('https://example.com/persist');
    } finally {
      await reopened.close();
    }
  });

  it('evicts old records by TTL like the vector mode does', async () => {
    const shortTtl = new KnowledgeStore({
      dbDir: testDbDir,
      embedder: null,
      retrieval: 'bm25',
      modelName: 'none',
      knowledgeMode: 'project',
      ttlDays: 1,
    });
    try {
      await shortTtl.open();
      const old = Date.now() - 3 * 24 * 60 * 60 * 1000; // 3 days old
      await shortTtl.addDocuments([
        { url: 'https://example.com/old', text: 'ancient document about mainframes', content: undefined, metadata: { ingestionType: 'synthesis-description' }, timestamp: old },
      ]);
      await shortTtl.close();

      // Eviction runs at open() — the re-open sweeps the TTL-expired row.
      const reopened = new KnowledgeStore({
        dbDir: testDbDir,
        embedder: null,
        retrieval: 'bm25',
        modelName: 'none',
        knowledgeMode: 'project',
        ttlDays: 1,
      });
      try {
        await reopened.open();
        const results = await reopened.search('ancient mainframes', { limit: 5 });
        expect(results).toHaveLength(0);
      } finally {
        await reopened.close();
      }
    } finally {
      // afterEach closes `store`, which was never opened here — closing an
      // unopened store must be safe; it is (isClosing latch + null handles).
    }
  });
});
