import { describe, it, expect } from 'vitest';
import { buildModelRegistry, resolveModel } from '../../src/core/llm/model-registry-factory.ts';

describe('model resolution — buildModelRegistry embedded key merge', () => {
  it('includes providers with embedded models.json apiKeys in getAvailable()', () => {
    const registry = buildModelRegistry();
    const available = registry.getAvailable();
    const providers = [...new Set(available.map(m => m.provider))];
    // glm-coding key is embedded in models.json, not auth.json — must be available after fix
    expect(providers).toContain('glm-coding');
  });

  it('resolves glm-coding as default (first in models.json) when no model spec given', () => {
    const registry = buildModelRegistry();
    const resolved = resolveModel(registry);
    // models.json lists glm-coding before openrouter → glm-coding/glm-4.7 first
    expect(resolved.provider).toBe('glm-coding');
  });
});
