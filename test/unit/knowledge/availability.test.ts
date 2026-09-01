import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  probeKnowledgeStoreAvailability,
  clearAvailabilityCache,
  describeKnowledgeStoreUnavailability,
  type PackageResolver,
} from '../../../src/knowledge/availability.ts';

/**
 * Unit tests for the knowledge store availability probe.
 *
 * The probe answers "are the store's required packages resolvable on this
 * host?" via require.resolve — execution-free — so init can fail fast to a
 * clean settings-level OFF instead of burning the 5-attempt retry storm, and
 * so the settings surfaces can say WHY the store is off. The resolver is
 * injected in every test: none of these touch the real filesystem.
 */
describe('probeKnowledgeStoreAvailability', () => {
  beforeEach(() => {
    clearAvailabilityCache();
  });

  const resolving: PackageResolver = (spec) => `/node_modules/${spec}/index.js`;
  const missingTransformers: PackageResolver = (spec) => {
    if (spec === '@huggingface/transformers') throw new Error(`Cannot find package '${spec}'`);
    return resolving(spec);
  };
  const missingBoth: PackageResolver = (spec) => {
    throw new Error(`Cannot find package '${spec}'`);
  };

  it('reports available when every required package resolves', () => {
    const result = probeKnowledgeStoreAvailability(resolving);
    expect(result.available).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('names the skipped optional transformers package when only it is missing', () => {
    const result = probeKnowledgeStoreAvailability(missingTransformers);
    expect(result.available).toBe(false);
    expect(result.missing).toEqual(['@huggingface/transformers']);
  });

  it('reports every missing package when the install is broken', () => {
    const result = probeKnowledgeStoreAvailability(missingBoth);
    expect(result.available).toBe(false);
    expect(result.missing).toEqual(['@lancedb/lancedb', '@huggingface/transformers']);
  });

  it('resolves both packages through the default resolver and memoizes the verdict (settings paths run often)', async () => {
    // The default resolver runs require.resolve against the real install tree;
    // mock node:module so we can count resolutions without touching it.
    vi.resetModules(); // the module was statically imported above — re-evaluate under the mock
    const resolveSpy = vi.fn((spec: string) => `/node_modules/${spec}/index.js`);
    vi.doMock('node:module', () => ({
      createRequire: vi.fn(() => ({ resolve: resolveSpy })),
    }));
    const { probeKnowledgeStoreAvailability: freshProbe, clearAvailabilityCache: freshClear } =
      await import('../../../src/knowledge/availability.ts');

    freshProbe();
    freshProbe(); // memo hit — no second resolution round
    // 2 packages × 1 probe call; the second call must add nothing.
    expect(resolveSpy).toHaveBeenCalledTimes(2);
    expect(resolveSpy).toHaveBeenNthCalledWith(1, '@lancedb/lancedb');
    expect(resolveSpy).toHaveBeenNthCalledWith(2, '@huggingface/transformers');

    freshClear();
    freshProbe();
    expect(resolveSpy).toHaveBeenCalledTimes(4);

    vi.doUnmock('node:module');
    clearAvailabilityCache();
  });

  it('never memoizes injected resolvers — each call re-consults them (keeps tests hermetic)', () => {
    const spy = vi.fn(resolving);
    probeKnowledgeStoreAvailability(spy);
    probeKnowledgeStoreAvailability(spy);
    // 2 packages × 2 calls — an injected resolver is never answered from cache.
    expect(spy).toHaveBeenCalledTimes(4);
  });
});

describe('describeKnowledgeStoreUnavailability', () => {
  it('is empty when available — surfaces must render nothing', () => {
    expect(describeKnowledgeStoreUnavailability({ available: true, missing: [] })).toBe('');
  });

  it('points the transformers case at the optional-dependency install, not the platform', () => {
    const text = describeKnowledgeStoreUnavailability({ available: false, missing: ['@huggingface/transformers'] });
    expect(text).toContain('@huggingface/transformers');
    expect(text).toContain('optional');
    expect(text).toContain('OFF');
  });

  it('words the lancedb case as a broken install', () => {
    const text = describeKnowledgeStoreUnavailability({ available: false, missing: ['@lancedb/lancedb'] });
    expect(text).toContain('@lancedb/lancedb');
    expect(text).toContain('broken install');
  });

  it('pluralizes correctly when both packages are missing', () => {
    const text = describeKnowledgeStoreUnavailability({
      available: false,
      missing: ['@lancedb/lancedb', '@huggingface/transformers'],
    });
    expect(text).toContain('packages not resolvable');
    expect(text).toContain(';');
  });
});
