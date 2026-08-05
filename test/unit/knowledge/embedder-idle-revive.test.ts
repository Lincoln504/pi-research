/**
 * Embedder — initialize() racing an in-flight dispose.
 *
 * The idle timer releases the pipeline purely to reclaim GPU/host memory; the
 * next embed is meant to bring it straight back. But dispose() flips the state
 * synchronously and then waits (up to ~5s for in-flight embeds, plus the
 * pipeline's own teardown), and for that whole window initialize() threw
 * "Cannot initialize while disposing". Nothing classifies that string as
 * transient, so the knowledge writer queue took the generic branch and DROPPED
 * the document — no retry, counted as `ingest_error`.
 *
 * A TERMINAL dispose (shutdown, config change) must still refuse, or teardown
 * would resurrect the ONNX pipeline it is trying to release.
 */

import { describe, it, expect, vi } from 'vitest';
import { Embedder } from '../../../src/knowledge/embedder.ts';

vi.mock('@huggingface/transformers', () => ({
  env: { cacheDir: '' },
  pipeline: vi.fn().mockImplementation(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const fn: any = vi.fn().mockResolvedValue({ dims: [384], data: new Float32Array(384).fill(0.1) });
    // Give teardown something slow enough to hold the 'disposing' window open.
    fn.dispose = vi.fn().mockImplementation(() => new Promise((r) => setTimeout(r, 60)));
    return fn;
  }),
}));

function newEmbedder(): Embedder {
  return new Embedder({ model: 'test-model', device: 'cpu' });
}

describe('Embedder — idle dispose is a pause, not an end', () => {
  it('revives instead of throwing when initialize() lands mid idle-dispose', async () => {
    const embedder = newEmbedder();
    await embedder.initialize();

    // Start the idle dispose and let it get past the synchronous state flip.
    const disposing = embedder.dispose('idle');
    await Promise.resolve();
    expect((embedder as any).state).toBe('disposing');

    // This is the call that used to throw and cost a document.
    await expect(embedder.initialize()).resolves.toBeUndefined();
    expect((embedder as any).state).toBe('ready');

    await disposing;
    await embedder.dispose();
  });

  it('still refuses to revive during a TERMINAL dispose', async () => {
    const embedder = newEmbedder();
    await embedder.initialize();

    const disposing = embedder.dispose(); // default = terminal
    await Promise.resolve();
    expect((embedder as any).state).toBe('disposing');

    await expect(embedder.initialize()).rejects.toThrow('Cannot initialize while disposing');

    await disposing;
    expect((embedder as any).state).toBe('idle');
  });

  it('a terminal dispose landing on an in-flight idle dispose downgrades it (no resurrection)', async () => {
    const embedder = newEmbedder();
    await embedder.initialize();

    const idle = embedder.dispose('idle');
    await Promise.resolve();
    // Shutdown arrives while the idle teardown is still running.
    const terminal = embedder.dispose('terminal');

    await expect(embedder.initialize()).rejects.toThrow('Cannot initialize while disposing');

    await Promise.all([idle, terminal]);
    expect((embedder as any).state).toBe('idle');
  });

  it('embed() after an idle dispose works rather than surfacing an unclassified error', async () => {
    const embedder = newEmbedder();
    await embedder.initialize();

    const disposing = embedder.dispose('idle');
    await Promise.resolve();

    const vector = await embedder.embed('some document text');
    expect(vector).toBeInstanceOf(Float32Array);
    expect(vector.length).toBe(384);

    await disposing;
    await embedder.dispose();
  });
});
