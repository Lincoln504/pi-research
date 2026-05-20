import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/logger.ts', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

describe('utils/prompts', () => {
  it('loads a real prompt file that exists', async () => {
    const { loadPrompt } = await import('../../../src/utils/prompts.ts');
    // researcher.md exists at src/prompts/researcher.md
    const content = loadPrompt('researcher');
    expect(typeof content).toBe('string');
    expect(content.length).toBeGreaterThan(0);
  });

  it('returns empty string for a non-existent prompt', async () => {
    const { loadPrompt } = await import('../../../src/utils/prompts.ts');
    const content = loadPrompt('does-not-exist-xyz');
    expect(content).toBe('');
  });

  it('loads prompt with custom relative path', async () => {
    const { loadPrompt } = await import('../../../src/utils/prompts.ts');
    // Should not throw — either loads content or returns empty string
    const content = loadPrompt('researcher', '..');
    expect(typeof content).toBe('string');
  });
});
