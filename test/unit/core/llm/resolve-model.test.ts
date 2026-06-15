/**
 * Unit Tests: resolveModel() — model-registry-factory bare-id resolution
 *
 * The same model id can be registered under multiple providers: a
 * user-configured authed provider plus pi's built-in keyless one (e.g.
 * `glm-coding/glm-4.7` with an API key vs `zai/glm-4.7` with none). A bare-id
 * spec must resolve to the authed provider, never the keyless one — otherwise
 * the first LLM call dies with "No API key for provider". An explicit
 * "provider/id" spec must still be honored verbatim.
 */

import { describe, it, expect } from 'vitest';
import type { ModelRegistry } from '@earendil-works/pi-coding-agent';
import { resolveModel } from '../../../../src/core/llm/model-registry-factory.ts';

type M = { id: string; provider: string };

function mockRegistry(all: M[], available: M[] = all): ModelRegistry {
  return {
    getAll: () => all,
    getAvailable: () => available,
    find: (prov: string, id: string) => all.find((m) => m.provider === prov && m.id === id),
  } as unknown as ModelRegistry;
}

describe('resolveModel() — bare-id resolution prefers an authed provider', () => {
  const dupId: M[] = [
    { id: 'glm-4.7', provider: 'zai' },          // pi built-in, keyless
    { id: 'glm-4.7', provider: 'glm-coding' },   // user config, authed
  ];

  it('bare id resolves to the authed provider, not the first/keyless one', () => {
    const reg = mockRegistry(dupId, [{ id: 'glm-4.7', provider: 'glm-coding' }]);
    const m = resolveModel(reg, 'glm-4.7');
    expect(m.provider).toBe('glm-coding');
  });

  it('explicit "provider/id" is honored verbatim even when that provider is keyless', () => {
    const reg = mockRegistry(dupId, [{ id: 'glm-4.7', provider: 'glm-coding' }]);
    const m = resolveModel(reg, 'zai/glm-4.7');
    expect(m.provider).toBe('zai');
  });

  it('falls back to the sole same-id entry when none are authed', () => {
    const reg = mockRegistry([{ id: 'solo', provider: 'p1' }], []);
    const m = resolveModel(reg, 'solo');
    expect(m.provider).toBe('p1');
  });

  it('throws on an unknown bare id', () => {
    const reg = mockRegistry(dupId, dupId);
    expect(() => resolveModel(reg, 'does-not-exist')).toThrow(/Invalid model string/);
  });
});
