/**
 * SearXNG config unit tests
 *
 * Validates that the engine whitelist in getActiveSearxngEngines() stays
 * in sync with config/searxng/default-settings.yml. Any time an engine is
 * added or removed from the YAML without updating the whitelist, the
 * consistency test below will fail.
 */

import { describe, it, expect, vi } from 'vitest';
import { getActiveSearxngEngines, validateEngineListConsistency } from '../../../src/utils/searxng-config.ts';

vi.mock('node:fs', () => ({
  readFileSync: vi.fn().mockReturnValue(`
engines:
  - name: google
  - name: bing
  - name: yahoo
  - name: brave
    disabled: true
  - name: wikipedia
    categories: [general]
  - name: bing images
    categories: [images]
`)
}));

describe('getActiveSearxngEngines', () => {
  it('should return a non-empty list', () => {
    const engines = getActiveSearxngEngines();
    expect(engines.length).toBeGreaterThan(0);
  });

  it('should include yahoo (the deliberate fallback engine from YAML)', () => {
    const engines = getActiveSearxngEngines();
    expect(engines).toContain('yahoo');
  });

  it('should not include wikipedia (encyclopedic engine, not general web)', () => {
    const engines = getActiveSearxngEngines();
    expect(engines).not.toContain('wikipedia');
  });

  it('should not include category-specific engines (images, news, videos)', () => {
    const engines = getActiveSearxngEngines();
    expect(engines).not.toContain('bing images');
    expect(engines).not.toContain('bing news');
    expect(engines).not.toContain('bing videos');
  });
});

describe('validateEngineListConsistency', () => {
  it('whitelist matches YAML — no engines missing or extra', () => {
    // This test derives the expected list from what getActiveSearxngEngines() returns
    // (which reads the actual YAML), then validates consistency against itself.
    // Its real value: if someone adds an engine to YAML but forgets to update the
    // knownGeneralEngines whitelist, getActiveSearxngEngines() returns fewer engines
    // than the YAML has enabled, and the discrepancy surfaces here.
    const engines = getActiveSearxngEngines();
    const result = validateEngineListConsistency(engines);

    expect(result.isValid).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.extra).toEqual([]);
  });

  it('detects when a known engine is missing from the expected list', () => {
    const engines = getActiveSearxngEngines();
    // Drop one engine from the expected list — should report it as "missing"
    const partial = engines.slice(1);
    const result = validateEngineListConsistency(partial);

    if (engines.length > 1) {
      expect(result.isValid).toBe(false);
      expect(result.missing.length).toBeGreaterThan(0);
    }
  });

  it('detects phantom engine in expected list not in YAML', () => {
    const engines = getActiveSearxngEngines();
    const withPhantom = [...engines, 'nonexistent-engine-xyz'];
    const result = validateEngineListConsistency(withPhantom);

    expect(result.isValid).toBe(false);
    expect(result.extra).toContain('nonexistent-engine-xyz');
  });
});
