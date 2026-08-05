import { describe, it, expect } from 'vitest';
import { resolveExcludedTools, DEFAULT_EXCLUDED_TOOLS } from '../../src/constants.ts';

describe('resolveExcludedTools', () => {
  it('treats undefined and [] identically as "no preference"', () => {
    expect(resolveExcludedTools(undefined)).toEqual([...DEFAULT_EXCLUDED_TOOLS]);
    expect(resolveExcludedTools([])).toEqual([...DEFAULT_EXCLUDED_TOOLS]);
  });
  it('lets an explicit caller list replace the default', () => {
    expect(resolveExcludedTools(['stackexchange'])).toEqual(['stackexchange']);
  });
  it('keeps PI_RESEARCH_DISABLED_TOOLS strictly additive', () => {
    // The regression: disabling an unrelated tool used to ENABLE grep.
    expect(resolveExcludedTools(undefined, ['stackexchange'])).toContain('grep');
    expect(resolveExcludedTools(undefined, ['stackexchange'])).toContain('stackexchange');
  });
  it('deduplicates overlapping entries', () => {
    expect(resolveExcludedTools(['grep'], ['grep'])).toEqual(['grep']);
  });
});
