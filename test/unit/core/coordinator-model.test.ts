/**
 * Round-1 coordinator model selection.
 *
 * Default (`PI_RESEARCH_COORDINATOR_MODEL` unset) is the parent chat's model, for
 * prompt-cache continuity. The setting exists because that default is wrong when the
 * chat model is not a planner — measured 2026-10-25 on this host, the chat model was a
 * local single-seat llama-swap server and round-1 planning took 2m07s.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  parseCoordinatorModelChoice,
  resolveCoordinatorModel,
  findModelByReference,
} from '../../../src/core/llm/coordinator-model.ts';

const HOST = { provider: 'local', id: 'Qwen3.8-27B' };
const RESEARCH = { provider: 'openrouter', id: '~deepseek/deepseek-flash-latest' };

describe('parseCoordinatorModelChoice', () => {
  it('treats unset, blank and "host" as host', () => {
    expect(parseCoordinatorModelChoice(undefined)).toEqual({ kind: 'host' });
    expect(parseCoordinatorModelChoice(null)).toEqual({ kind: 'host' });
    expect(parseCoordinatorModelChoice('')).toEqual({ kind: 'host' });
    expect(parseCoordinatorModelChoice('   ')).toEqual({ kind: 'host' });
    expect(parseCoordinatorModelChoice('host')).toEqual({ kind: 'host' });
    expect(parseCoordinatorModelChoice('HOST')).toEqual({ kind: 'host' });
  });

  it('recognises "research" case-insensitively', () => {
    expect(parseCoordinatorModelChoice('research')).toEqual({ kind: 'research' });
    expect(parseCoordinatorModelChoice(' Research ')).toEqual({ kind: 'research' });
  });

  it('treats anything else as an explicit model reference, verbatim', () => {
    expect(parseCoordinatorModelChoice('openrouter/anthropic/claude-sonnet-4')).toEqual({
      kind: 'explicit',
      reference: 'openrouter/anthropic/claude-sonnet-4',
    });
  });
});

describe('resolveCoordinatorModel', () => {
  it('defaults to the chat model', () => {
    expect(resolveCoordinatorModel({ setting: undefined, hostModel: HOST, researchModel: RESEARCH })).toBe(HOST);
  });

  it('falls back to the research model when there is no chat model', () => {
    expect(resolveCoordinatorModel({ setting: undefined, hostModel: undefined, researchModel: RESEARCH })).toBe(RESEARCH);
  });

  it('"research" picks the research model', () => {
    expect(resolveCoordinatorModel({ setting: 'research', hostModel: HOST, researchModel: RESEARCH })).toBe(RESEARCH);
  });

  it('an explicit reference is resolved through the supplied lookup', () => {
    const explicit = { provider: 'openai', id: 'gpt-5' };
    const findByReference = vi.fn(() => explicit);
    expect(resolveCoordinatorModel({ setting: 'openai/gpt-5', hostModel: HOST, researchModel: RESEARCH, findByReference }))
      .toBe(explicit);
    expect(findByReference).toHaveBeenCalledWith('openai/gpt-5');
  });

  it('an unresolvable explicit reference falls back to the RESEARCH model, never the chat model', () => {
    // The setting exists to get planning off the chat model. Falling back to the
    // chat model on a typo would look applied while behaving exactly as before.
    const onUnresolved = vi.fn();
    const resolved = resolveCoordinatorModel({
      setting: 'openai/typo',
      hostModel: HOST,
      researchModel: RESEARCH,
      findByReference: () => undefined,
      onUnresolved,
    });
    expect(resolved).toBe(RESEARCH);
    expect(onUnresolved).toHaveBeenCalledWith('openai/typo');
  });
});

describe('findModelByReference', () => {
  const authed = { provider: 'openai', id: 'gpt-5' };
  const keyless = { provider: 'openai-oauth', id: 'gpt-5' };
  const all = [keyless, authed];

  it('finds an exact provider/id', () => {
    expect(findModelByReference('openai/gpt-5', all, [authed])).toBe(authed);
  });

  it('prefers an authed provider for a bare id', () => {
    expect(findModelByReference('gpt-5', all, [authed])).toBe(authed);
    // With nothing reported available, the first same-id entry is used.
    expect(findModelByReference('gpt-5', all, [])).toBe(keyless);
  });

  it('returns undefined for an unknown reference (the property resolveResearchModel lacks)', () => {
    // This is what makes COORDINATOR_MODEL's typo path honest: the caller can now fall
    // back to the research model AND warn, instead of silently running on an arbitrary model.
    expect(findModelByReference('openai/typo', all, [authed])).toBeUndefined();
    expect(findModelByReference('typo', [], [])).toBeUndefined();
  });
});
