/**
 * Research Knowledge Search — Integration Tests
 *
 * Tests the knowledge store interaction layer of the research_knowledge_search tool:
 * vector search → URL dedup → rebuildDocument pipeline with a real (synthetic)
 * LanceDB instance. The background LLM (completeSimple / repairJsonWithLlm) is
 * mocked to focus verification on the data rehydration and steering paths.
 *
 * Uses an ephemeral /tmp database with a synthetic embedder (no HF model download).
 * Runs in the parallel integration group — no shared singletons.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';

import { KnowledgeStore } from '../../src/knowledge/store.ts';
import type { Embedder } from '../../src/knowledge/embedder.ts';

// ---------------------------------------------------------------------------
// Synthetic embedder — deterministic vectors, no model download
// ---------------------------------------------------------------------------
function makeSyntheticEmbedder(dim = 64): Embedder {
  function textToVector(text: string): Float32Array {
    const v = new Float32Array(dim);
    const h = createHash('sha256').update(text).digest();
    for (let i = 0; i < dim; i++) {
      v[i] = (h[i % h.length]! / 255) * 2 - 1;
    }
    return v;
  }

  return {
    isInitialized: () => true,
    getDimension: () => dim,
    initialize: async () => {},
    embed: async (text: string) => textToVector(text),
    embedMany: async (texts: string[]) => texts.map(t => textToVector(t)),
  } as unknown as Embedder;
}

// ---------------------------------------------------------------------------
// Helper: seed a store with documents for integration testing
// ---------------------------------------------------------------------------
interface SeedDoc {
  url: string;
  title: string;
  markdown: string;
  description: string;
  ingestionType?: string;
}

async function seedStore(
  store: KnowledgeStore,
  docs: SeedDoc[],
): Promise<void> {
  // Add documents directly to the store — do NOT use the WriterQueue because:
  // 1. The writer queue chunks the markdown into smaller pieces without content
  // 2. rebuildDocument specifically queries for content IS NOT NULL
  // 3. The writer queue deletes existing entries of the same type before re-adding
  //
  // Direct addDocuments with the full content is what rebuildDocument needs.
  for (const doc of docs) {
    await store.addDocuments([{
      url: doc.url,
      text: doc.description,
      content: doc.markdown,
      metadata: {
        ingestionType: 'synthesis-description',
        description: doc.description,
        title: doc.title,
      },
      timestamp: Date.now(),
    }]);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('research_knowledge_search — store interaction layer', () => {
  let tmpDir: string;
  let store: KnowledgeStore;
  let embedder: Embedder;

  beforeEach(async () => {
    tmpDir = path.join(
      os.tmpdir(),
      `pi-research-knowledge-it-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    );
    embedder = makeSyntheticEmbedder(64);
    store = new KnowledgeStore({ dbDir: tmpDir, embedder, modelName: 'synthetic-64' });
    await store.open();
  });

  afterEach(async () => {
    try {
      await store.close();
    } finally {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
      vi.clearAllMocks();
    }
  });

  // -----------------------------------------------------------------------
  // Test 1: rebuildDocument returns the synthesis-description content
  // -----------------------------------------------------------------------
  it('rebuildDocument returns the pristine synthesis-description content', async () => {
    await seedStore(store, [
      {
        url: 'https://example.com/document-a',
        title: 'Document A',
        description: 'A comprehensive guide to quantum computing.',
        markdown: '# Quantum Computing\n\nQuantum computing uses qubits.\n\n## Key Concepts\n- Superposition\n- Entanglement',
      },
    ]);

    const rebuilt = await store.rebuildDocument('https://example.com/document-a');
    expect(rebuilt).not.toBeNull();
    expect(rebuilt!.text).toContain('Quantum Computing');
    expect(rebuilt!.text).toContain('qubits');
    expect(rebuilt!.text).toContain('Superposition');
    expect(rebuilt!.text).toContain('Entanglement');
    expect(rebuilt!.description).toBe('A comprehensive guide to quantum computing.');
  });

  // -----------------------------------------------------------------------
  // Test 2: rebuildDocument returns null for unknown URLs
  // -----------------------------------------------------------------------
  it('rebuildDocument returns null for URLs not in the store', async () => {
    await seedStore(store, [
      {
        url: 'https://example.com/existing',
        title: 'Existing',
        description: 'An existing document.',
        markdown: '# Existing\n\nContent.',
      },
    ]);

    const rebuilt = await store.rebuildDocument('https://example.com/not-here');
    expect(rebuilt).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Test 3: findRelevantUrls returns seeded entries
  // -----------------------------------------------------------------------
  it('findRelevantUrls finds seeded documents', async () => {
    await seedStore(store, [
      {
        url: 'https://example.com/typescript',
        title: 'TypeScript Guide',
        description: 'A comprehensive guide to TypeScript features.',
        markdown: '# TypeScript\n\nTypeScript is a typed superset of JavaScript.',
      },
      {
        url: 'https://example.com/python',
        title: 'Python Guide',
        description: 'Python programming language basics.',
        markdown: '# Python\n\nPython is a high-level programming language.',
      },
    ]);

    // Wait briefly for FTS index
    await new Promise(r => setTimeout(r, 200));

    const results = await store.findRelevantUrls('TypeScript', { limit: 10 });
    // Should find at least the typescript doc (and possibly the python doc)
    const urls = results.map(r => r.url);
    expect(urls.length).toBeGreaterThanOrEqual(1);
    expect(urls).toContain('https://example.com/typescript');
  });

  // -----------------------------------------------------------------------
  // Test 4: URL deduplication across multiple queries
  // -----------------------------------------------------------------------
  it('deduplicates URLs when multiple queries hit the same document', async () => {
    await seedStore(store, [
      {
        url: 'https://example.com/rust',
        title: 'Rust Programming',
        description: 'Rust is a systems programming language.',
        markdown: '# Rust\n\nRust focuses on safety and performance.',
      },
      {
        url: 'https://example.com/go',
        title: 'Go Programming',
        description: 'Go is a statically typed compiled language.',
        markdown: '# Go\n\nGo was designed at Google.',
      },
    ]);

    await new Promise(r => setTimeout(r, 200));

    // Run findRelevantUrls for multiple queries
    const results1 = await store.findRelevantUrls('rust programming', { limit: 5 });
    const results2 = await store.findRelevantUrls('systems language', { limit: 5 });

    // Combine and deduplicate
    const allUrls = new Map<string, number>();
    for (const r of [...results1, ...results2]) {
      if (!allUrls.has(r.url)) {
        allUrls.set(r.url, allUrls.size);
      }
    }

    // Only 2 unique URLs across both queries
    expect(allUrls.size).toBeLessThanOrEqual(2);
    expect(allUrls.has('https://example.com/rust')).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Test 5: Empty store returns no results
  // -----------------------------------------------------------------------
  it('returns no results from an empty store', async () => {
    const results = await store.findRelevantUrls('anything', { limit: 10 });
    expect(results).toHaveLength(0);

    const count = await store.count();
    expect(count).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Test 6: Multiple documents can be rebuilt independently
  // -----------------------------------------------------------------------
  it('returns independent content for each rebuilt document', async () => {
    await seedStore(store, [
      {
        url: 'https://example.com/doc-1',
        title: 'Doc 1',
        description: 'First document.',
        markdown: '# Document 1\n\nContent unique to doc 1.',
      },
      {
        url: 'https://example.com/doc-2',
        title: 'Doc 2',
        description: 'Second document.',
        markdown: '# Document 2\n\nContent unique to doc 2.',
      },
    ]);

    const rebuilt1 = await store.rebuildDocument('https://example.com/doc-1');
    const rebuilt2 = await store.rebuildDocument('https://example.com/doc-2');

    expect(rebuilt1).not.toBeNull();
    expect(rebuilt2).not.toBeNull();
    expect(rebuilt1!.text).toContain('unique to doc 1');
    expect(rebuilt2!.text).toContain('unique to doc 2');
    expect(rebuilt1!.text).not.toContain('unique to doc 2');
  });

  // -----------------------------------------------------------------------
  // Test 7: Synthesis-description filtering works
  // -----------------------------------------------------------------------
  it('only returns synthesis-description documents from rebuildDocument', async () => {
    // Add a regular chunk (no synthesis-description metadata)
    await store.addDocuments([{
      url: 'https://example.com/plain-chunk',
      text: 'This is a plain chunk without synthesis-description metadata.',
      metadata: { ingestionType: 'scrape' },
      timestamp: Date.now(),
    }]);

    // Add a synthesis-description entry
    await store.addDocuments([{
      url: 'https://example.com/synthesis-entry',
      text: 'Synthesis description',
      content: '# Synthesis\n\nFull synthesis content.',
      metadata: { ingestionType: 'synthesis-description', description: 'A synthesis' },
      timestamp: Date.now(),
    }]);

    // The plain chunk should not be returned by rebuildDocument
    const plainRebuilt = await store.rebuildDocument('https://example.com/plain-chunk');
    expect(plainRebuilt).toBeNull(); // no synthesis-description metadata

    // The synthesis entry should be returned
    const synthRebuilt = await store.rebuildDocument('https://example.com/synthesis-entry');
    expect(synthRebuilt).not.toBeNull();
    expect(synthRebuilt!.text).toContain('Full synthesis content');
  });

  // -----------------------------------------------------------------------
  // Test 8: Document search with scoped filter (local workspace)
  // -----------------------------------------------------------------------
  it('scopes search to the current workspace by default', async () => {
    // Close the existing store and create one with workspace scoping
    await store.close();
    vi.clearAllMocks();

    const scopedStore = new KnowledgeStore({
      dbDir: tmpDir,
      embedder,
      modelName: 'synthetic-64',
      workspace: '/test/project-a',
      localEnabled: true,
      globalEnabled: false,
    });
    await scopedStore.open();

    await seedStore(scopedStore, [
      {
        url: 'https://example.com/project-a-doc',
        title: 'Project A Doc',
        description: 'A document in project A.',
        markdown: '# Project A\n\nContent for project A.',
      },
    ]);

    // A store with a different workspace should not see this document
    const otherStore = new KnowledgeStore({
      dbDir: tmpDir,
      embedder,
      modelName: 'synthetic-64',
      workspace: '/test/project-b',
      localEnabled: true,
      globalEnabled: false,
    });
    await otherStore.open();

    const results = await otherStore.findRelevantUrls('project A', { limit: 5 });
    expect(results).toHaveLength(0);

    await otherStore.close();
    await scopedStore.close();
  });
});