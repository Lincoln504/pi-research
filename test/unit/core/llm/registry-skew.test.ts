/**
 * Host/SDK ModelRegistry version-skew resilience.
 *
 * The registry passed to the research resolvers can come from the pi/openclaw
 * host (ctx.modelRegistry), which may be built against a different
 * pi-coding-agent than this package. A live run crashed 6 researchers with
 * "modelRegistry.getAvailable is not a function". These tests pin the
 * feature-detecting accessors and the resolver so a missing/throwing method
 * DEGRADES (falls back) instead of throwing a raw TypeError mid-research.
 */

import { describe, it, expect } from 'vitest';
import { safeGetAll, safeGetAvailable, safeGetApiKeyAndHeaders } from '../../../../src/core/llm/model-registry-factory.ts';
import { resolveResearchModel } from '../../../../src/core/llm/research-model-resolver.ts';

const MODELS = [
  { provider: 'glm-coding', id: 'glm-4.7' },
  { provider: 'zai', id: 'glm-4.7' },
];

describe('safeGetAll / safeGetAvailable — version-skew tolerance', () => {
  it('returns models from a well-formed registry', () => {
    const reg: any = { getAll: () => MODELS, getAvailable: () => [MODELS[0]] };
    expect(safeGetAll(reg)).toHaveLength(2);
    expect(safeGetAvailable(reg)).toEqual([MODELS[0]]);
  });

  it('falls back to getAll() when the host registry has no getAvailable()', () => {
    const reg: any = { getAll: () => MODELS }; // older/newer host: no getAvailable
    expect(safeGetAvailable(reg)).toEqual(MODELS);
  });

  it('falls back to getAll() when getAvailable() throws', () => {
    const reg: any = { getAll: () => MODELS, getAvailable: () => { throw new Error('boom'); } };
    expect(safeGetAvailable(reg)).toEqual(MODELS);
  });

  it('returns [] (never throws) for a registry missing every method', () => {
    expect(safeGetAvailable({} as any)).toEqual([]);
    expect(safeGetAll({} as any)).toEqual([]);
    expect(safeGetAvailable(null)).toEqual([]);
    expect(safeGetAll(undefined)).toEqual([]);
  });
});

describe('safeGetApiKeyAndHeaders — version-skew tolerance', () => {
  const model: any = { provider: 'glm-coding', id: 'glm-4.7' };

  it('passes through a successful auth result', async () => {
    const reg: any = { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'k', headers: { a: '1' } }) };
    await expect(safeGetApiKeyAndHeaders(reg, model)).resolves.toEqual({ ok: true, apiKey: 'k', headers: { a: '1' } });
  });

  it('returns ok:false (never throws) when the host registry has no getApiKeyAndHeaders()', async () => {
    const result = await safeGetApiKeyAndHeaders({} as any, model);
    expect(result.ok).toBe(false);
  });

  it('returns ok:false (never throws) when getApiKeyAndHeaders() throws', async () => {
    const reg: any = { getApiKeyAndHeaders: async () => { throw new Error('host skew'); } };
    const result = await safeGetApiKeyAndHeaders(reg, model);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('host skew');
  });

  it('returns ok:false for a null/undefined registry', async () => {
    expect((await safeGetApiKeyAndHeaders(null, model)).ok).toBe(false);
    expect((await safeGetApiKeyAndHeaders(undefined, model)).ok).toBe(false);
  });
});

describe('resolveResearchModel — does not crash on a skewed registry', () => {
  it('resolves via host model when the registry lacks getAvailable()', () => {
    const hostModel: any = { provider: 'glm-coding', id: 'glm-4.7' };
    const reg: any = { getAll: () => MODELS }; // no getAvailable — would have thrown before the fix
    const resolved = resolveResearchModel({
      modelRegistry: reg,
      config: { RESEARCH_MODEL: undefined } as any,
      hostModel,
    });
    expect(resolved).toBe(hostModel);
  });

  it('resolves a configured RESEARCH_MODEL by id even without getAvailable()', () => {
    const reg: any = { getAll: () => MODELS }; // getAvailable missing
    const resolved = resolveResearchModel({
      modelRegistry: reg,
      config: { RESEARCH_MODEL: 'glm-coding/glm-4.7' } as any,
    });
    expect(resolved).toMatchObject({ provider: 'glm-coding', id: 'glm-4.7' });
  });

  it('falls back to a known model when getAvailable() is absent and no host model is given', () => {
    const reg: any = { getAll: () => MODELS }; // only getAll
    const resolved = resolveResearchModel({
      modelRegistry: reg,
      config: { RESEARCH_MODEL: undefined } as any,
    });
    // Must return SOME model rather than throwing "No LLM model available".
    expect(resolved).toBeTruthy();
    expect(resolved.id).toBe('glm-4.7');
  });
});
