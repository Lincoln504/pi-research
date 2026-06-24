import { describe, it, expect } from 'vitest';
import { pickPreferredAvailable } from '../../src/core/llm/model-registry-factory.ts';

/**
 * The "first available model" fallback must respect the user's models.json
 * provider order, not pi-ai's fixed built-in catalog order (where openrouter is
 * 26th and user-configured providers like glm-coding are appended last). This is
 * tested against the PURE selection function so it is hermetic — it does not read
 * the developer's real ~/.pi/agent/models.json (which made the prior test pass
 * locally but fail on a clean CI runner).
 */
describe('pickPreferredAvailable — models.json-order fallback', () => {
  const available = [
    { provider: 'zai', id: 'glm-4.7' },
    { provider: 'openrouter', id: 'gpt-4o' },
    { provider: 'glm-coding', id: 'glm-4.7' },
  ];

  it('prefers the provider listed first in models.json order', () => {
    // User put glm-coding before openrouter in models.json.
    const picked = pickPreferredAvailable(available, ['glm-coding', 'openrouter', 'zai']);
    expect(picked?.provider).toBe('glm-coding');
  });

  it('skips configured providers that are not actually available', () => {
    // anthropic is in the order but not available → first available in-order wins.
    const picked = pickPreferredAvailable(available, ['anthropic', 'openrouter']);
    expect(picked?.provider).toBe('openrouter');
  });

  it('falls back to the first available model when no configured provider matches', () => {
    const picked = pickPreferredAvailable(available, ['nonexistent']);
    expect(picked?.provider).toBe('zai');
  });

  it('falls back to the first available model when the order is empty (no models.json)', () => {
    const picked = pickPreferredAvailable(available, []);
    expect(picked?.provider).toBe('zai');
  });

  it('returns undefined when nothing is available', () => {
    expect(pickPreferredAvailable([], ['glm-coding'])).toBeUndefined();
  });
});
