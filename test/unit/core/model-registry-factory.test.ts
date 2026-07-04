/**
 * model-registry-factory unit tests — the pure pieces.
 *
 * constructMinimalModel is the no-registry fallback for keyed standalone users
 * (explicit PI_RESEARCH_API_KEY, no pi models.json). Its `api` id must be a REAL
 * pi-ai api id: an invalid one passes pre-flight and dies on the first LLM call.
 */

import { describe, it, expect } from 'vitest';
import { constructMinimalModel } from '../../../src/core/llm/model-registry-factory.ts';

// The KnownApi union from @earendil-works/pi-ai (types.d.ts). Kept literal here
// on purpose: if pi-ai renames an id, this test fails loudly instead of the
// mapping silently emitting a stale one.
const KNOWN_APIS = new Set([
  'openai-completions',
  'mistral-conversations',
  'openai-responses',
  'azure-openai-responses',
  'openai-codex-responses',
  'anthropic-messages',
  'bedrock-converse-stream',
  'google-generative-ai',
  'google-vertex',
]);

describe('constructMinimalModel', () => {
  it.each([
    ['openai', 'openai-completions'],
    ['anthropic', 'anthropic-messages'],
    ['google', 'google-generative-ai'],
    ['gemini', 'google-generative-ai'],
    ['mistral', 'mistral-conversations'],
    // Unknown/third-party providers default to the OpenAI-compatible protocol.
    ['openrouter', 'openai-completions'],
    ['cerebras', 'openai-completions'],
    ['some-custom-endpoint', 'openai-completions'],
  ])('maps provider %s to api %s', (provider, expectedApi) => {
    const m = constructMinimalModel(provider, 'some-model', 'sk-test');
    expect(m.api).toBe(expectedApi);
    expect(KNOWN_APIS.has(m.api as string)).toBe(true);
    expect(m.provider).toBe(provider);
    expect(m.id).toBe('some-model');
  });
});
