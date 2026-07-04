/**
 * Research Knowledge Search — Unit Tests
 *
 * Tests the stateless, algorithmic logic of the research_knowledge_search tool:
 * schema validation, URL deduplication + token budgeting (the real
 * assembleReferenceDocuments), tri-state answer steering (the real
 * buildSteeringResult), model resolution (the real resolveResearchModel),
 * and TUI panel rendering.
 *
 * These tests drive the actual source functions — not local reimplementations —
 * so they fail if the real logic regresses. All I/O (vector store, LLM) is
 * mocked; no file I/O, no network, no real LLM calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Value } from 'typebox/value';

// The relevance-triage LLM call goes through completeSimple; mock it so the triage
// tests drive the REAL triageRelevantUrls logic with scripted model output.
const { mockCompleteSimple } = vi.hoisted(() => ({ mockCompleteSimple: vi.fn() }));
vi.mock('../../../src/core/llm/pi-ai-completion.ts', () => ({ completeSimple: mockCompleteSimple }));

import {
  ResearchKnowledgeSynthesisResponseSchema,
} from '../../../src/tools/research-knowledge-types.ts';
import {
  createResearchKnowledgeSearchTool,
  assembleReferenceDocuments,
  collectCandidateUrls,
  triageRelevantUrls,
  buildSteeringResult,
  isTransientSynthesisError,
  MAX_DOCUMENTS,
  MAX_CANDIDATES,
  TRIAGE_DESCRIPTION_MAX_CHARS,
  MAX_REFERENCE_CHARS,
  RESEARCH_KNOWLEDGE_MISS_STRING,
  RESEARCH_KNOWLEDGE_MAYBE_STRING,
  type KnowledgeCandidate,
} from '../../../src/tools/research-knowledge-search.ts';
import { resolveResearchModel } from '../../../src/core/llm/research-model-resolver.ts';
import type { IKnowledgeStore } from '../../../src/core/interfaces/knowledge-interfaces.ts';
import type { ModelRegistry } from '@earendil-works/pi-coding-agent';

// ---------------------------------------------------------------------------
// Transient-error classification for the synthesis retry (Bug 2 fix)
// ---------------------------------------------------------------------------
describe('isTransientSynthesisError — retry classification', () => {
  it.each([
    'Knowledge Extraction failed: API Rate Limit Exhausted.',
    'HTTP 429: Too Many Requests',
    'provider error 1310: limit exhausted',
    'knowledge-search-extraction timed out after 60000ms',
    'Knowledge Extraction returned no text content from LLM',
    'Service Unavailable (HTTP 503)',
    'Bad gateway 502',
    'Internal server error 500',
    'read ECONNRESET',
    'fetch failed',
    'Model is overloaded, please retry',
    'Knowledge Extraction failed: terminated',
    'other side closed',
    'socket hang up',
    'UND_ERR_SOCKET',
  ])('treats %j as transient (retryable)', (msg) => {
    expect(isTransientSynthesisError(msg)).toBe(true);
  });

  it.each([
    'invalid API key',
    'authentication failed (401)',
    'model not found',
    'malformed JSON in response',
    'HTTP 400: bad request',
  ])('treats %j as non-transient (no retry)', (msg) => {
    expect(isTransientSynthesisError(msg)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 1: Schema Validation (Phase 1)
// ---------------------------------------------------------------------------
describe('ResearchKnowledgeSynthesisResponseSchema — TypeBox validation', () => {

  it('accepts a perfectly formed response with answer_status="yes"', () => {
    const input = {
      answer_status: 'yes',
      synthesis: 'The sky is blue [1].',
      citations: ['https://example.com/sky'],
    };
    const coerced = Value.Convert(ResearchKnowledgeSynthesisResponseSchema, input) as Record<string, any>;
    expect(Value.Check(ResearchKnowledgeSynthesisResponseSchema, coerced)).toBe(true);
    expect(coerced['answer_status']).toBe('yes');
    expect(coerced['synthesis']).toBe('The sky is blue [1].');
    expect(coerced['citations']).toEqual(['https://example.com/sky']);
  });

  it('accepts a response with answer_status="no", no synthesis', () => {
    const input = {
      answer_status: 'no',
      citations: [],
    };
    const coerced = Value.Convert(ResearchKnowledgeSynthesisResponseSchema, input) as Record<string, any>;
    expect(Value.Check(ResearchKnowledgeSynthesisResponseSchema, coerced)).toBe(true);
    expect(coerced['answer_status']).toBe('no');
    expect((coerced as any)['synthesis']).toBeUndefined();
  });

  it('accepts a response with answer_status="maybe" with synthesis', () => {
    const input = {
      answer_status: 'maybe',
      synthesis: 'Partial info: the sky may be blue [1].',
      citations: ['https://example.com/sky'],
    };
    const coerced = Value.Convert(ResearchKnowledgeSynthesisResponseSchema, input) as Record<string, any>;
    expect(Value.Check(ResearchKnowledgeSynthesisResponseSchema, coerced)).toBe(true);
    expect(coerced['answer_status']).toBe('maybe');
    expect(coerced['synthesis']).toBe('Partial info: the sky may be blue [1].');
  });

  it('accepts "maybe" without synthesis (synthesis is optional)', () => {
    const input = {
      answer_status: 'maybe',
      citations: ['https://example.com/sky'],
    };
    const coerced = Value.Convert(ResearchKnowledgeSynthesisResponseSchema, input) as Record<string, any>;
    expect(Value.Check(ResearchKnowledgeSynthesisResponseSchema, coerced)).toBe(true);
  });

  it('rejects when answer_status is missing (required)', () => {
    const input = { citations: ['https://x.com'] };
    const coerced = Value.Convert(ResearchKnowledgeSynthesisResponseSchema, input) as Record<string, any>;
    expect(Value.Check(ResearchKnowledgeSynthesisResponseSchema, coerced)).toBe(false);
  });

  it('rejects when answer_status is not a valid enum value', () => {
    const input = { answer_status: 'perhaps', citations: [] };
    const coerced = Value.Convert(ResearchKnowledgeSynthesisResponseSchema, input) as Record<string, any>;
    expect(Value.Check(ResearchKnowledgeSynthesisResponseSchema, coerced)).toBe(false);
  });

  it('rejects when answer_status is a boolean', () => {
    const input = { answer_status: true, citations: [] };
    const coerced = Value.Convert(ResearchKnowledgeSynthesisResponseSchema, input) as Record<string, any>;
    expect(Value.Check(ResearchKnowledgeSynthesisResponseSchema, coerced)).toBe(false);
  });

  it('rejects when citations is missing (required)', () => {
    const input = { answer_status: 'yes' };
    const coerced = Value.Convert(ResearchKnowledgeSynthesisResponseSchema, input) as Record<string, any>;
    expect(Value.Check(ResearchKnowledgeSynthesisResponseSchema, coerced)).toBe(false);
  });

  it('converts string citations to array via Value.Convert (TypeBox leniency)', () => {
    const input = { answer_status: 'yes', synthesis: 'text', citations: 'not-an-array' as any };
    const coerced = Value.Convert(ResearchKnowledgeSynthesisResponseSchema, input) as Record<string, any>;
    expect(Array.isArray(coerced['citations'])).toBe(true);
  });

  it('coerces non-string citation values via Value.Convert (TypeBox leniency)', () => {
    const input = { answer_status: 'yes', synthesis: 'text', citations: [42] };
    const coerced = Value.Convert(ResearchKnowledgeSynthesisResponseSchema, input) as Record<string, any>;
    expect(Value.Check(ResearchKnowledgeSynthesisResponseSchema, coerced)).toBe(true);
    expect(coerced['citations'][0]!).toBe('42');
  });

  it('accepts citations as an empty array', () => {
    const input = { answer_status: 'yes', citations: [] };
    const coerced = Value.Convert(ResearchKnowledgeSynthesisResponseSchema, input) as Record<string, any>;
    expect(Value.Check(ResearchKnowledgeSynthesisResponseSchema, coerced)).toBe(true);
  });

  it('rejects unknown answer_status values like "unknown"', () => {
    const input = { answer_status: 'unknown', citations: [] };
    const coerced = Value.Convert(ResearchKnowledgeSynthesisResponseSchema, input) as Record<string, any>;
    expect(Value.Check(ResearchKnowledgeSynthesisResponseSchema, coerced)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Mock IKnowledgeStore — drives the REAL assembleReferenceDocuments.
// ---------------------------------------------------------------------------
/**
 * Build a minimal IKnowledgeStore whose findRelevantUrls returns scripted hits
 * per query and whose rebuildDocument returns scripted document text per URL.
 * Only the two methods assembleReferenceDocuments calls are implemented.
 */
function createMockStore(opts: {
  urlsByQuery: Record<string, Array<{ url: string; provenance?: string }>>;
  docText?: (url: string) => string | null;
}): IKnowledgeStore {
  return {
    findRelevantUrls: vi.fn(async (query: string) =>
      (opts.urlsByQuery[query] ?? []).map((e) => ({
        url: e.url,
        description: '',
        provenance: e.provenance,
      }))),
    rebuildDocument: vi.fn(async (url: string) => {
      const text = opts.docText ? opts.docText(url) : `Body of ${url}`;
      return text === null ? null : { text, description: null, metadata: {} };
    }),
  } as unknown as IKnowledgeStore;
}

// ---------------------------------------------------------------------------
// Test 2: URL Deduplication (real assembleReferenceDocuments)
// ---------------------------------------------------------------------------
describe('assembleReferenceDocuments — URL deduplication and ordering', () => {
  it('returns empty text and urls when the store finds nothing', async () => {
    const store = createMockStore({ urlsByQuery: {} });
    const { text, urls } = await assembleReferenceDocuments(['q1', 'q2'], store);
    expect(urls).toHaveLength(0);
    expect(text).toBe('');
  });

  it('deduplicates a URL surfaced by multiple queries', async () => {
    const store = createMockStore({
      urlsByQuery: {
        q1: [{ url: 'https://a.com' }],
        q2: [{ url: 'https://a.com' }, { url: 'https://b.com' }],
        q3: [{ url: 'https://a.com' }],
      },
    });
    const { urls, text } = await assembleReferenceDocuments(['q1', 'q2', 'q3'], store);
    expect(urls).toEqual(['https://a.com', 'https://b.com']);
    expect(text).toContain('### Source: https://a.com');
    expect(text).toContain('### Source: https://b.com');
  });

  it('preserves first-appearance order as the relevance ranking', async () => {
    const store = createMockStore({
      urlsByQuery: {
        q1: [{ url: 'https://c.com' }],
        q2: [{ url: 'https://a.com' }],
        q3: [{ url: 'https://b.com' }],
        q4: [{ url: 'https://a.com' }],
      },
    });
    const { urls } = await assembleReferenceDocuments(['q1', 'q2', 'q3', 'q4'], store);
    expect(urls).toEqual(['https://c.com', 'https://a.com', 'https://b.com']);
  });

  it('records the provenance of the first query that surfaced each URL', async () => {
    const store = createMockStore({
      urlsByQuery: { q: [{ url: 'https://a.com', provenance: 'wikipedia' }] },
    });
    const { text } = await assembleReferenceDocuments(['q'], store);
    expect(text).toContain('#### Provenance: wikipedia');
  });

  it('skips URLs whose document cannot be rebuilt (returns null)', async () => {
    const store = createMockStore({
      urlsByQuery: { q: [{ url: 'https://a.com' }, { url: 'https://b.com' }] },
      docText: (url) => (url === 'https://a.com' ? null : 'B body'),
    });
    const { text, urls } = await assembleReferenceDocuments(['q'], store);
    expect(urls).toEqual(['https://a.com', 'https://b.com']);
    expect(text).not.toContain('### Source: https://a.com');
    expect(text).toContain('### Source: https://b.com');
  });

  it('continues to the next query when one query throws (per-query try/catch)', async () => {
    const store = {
      findRelevantUrls: vi.fn(async (query: string) => {
        if (query === 'bad') throw new Error('vector search failed');
        return [{ url: 'https://a.com', description: '' }];
      }),
      rebuildDocument: vi.fn(async () => ({ text: 'A body', description: null, metadata: {} })),
    } as unknown as IKnowledgeStore;
    const { urls } = await assembleReferenceDocuments(['bad', 'good'], store);
    expect(urls).toEqual(['https://a.com']);
  });
});

// ---------------------------------------------------------------------------
// Test 3: Token Budget Enforcement (real assembleReferenceDocuments)
// ---------------------------------------------------------------------------
describe('assembleReferenceDocuments — token budget and document caps', () => {
  it('includes every document when the total is under budget', async () => {
    const store = createMockStore({
      urlsByQuery: { q: [{ url: 'https://a.com' }, { url: 'https://b.com' }] },
      docText: (url) => `Content for ${url}`,
    });
    const { text, urls } = await assembleReferenceDocuments(['q'], store);
    expect(urls).toEqual(['https://a.com', 'https://b.com']);
    expect(text).toContain('### Source: https://a.com');
    expect(text).toContain('### Source: https://b.com');
    expect(text).not.toContain('[TRUNCATED]');
  });

  it('caps rebuilt documents at MAX_DOCUMENTS unique URLs', async () => {
    const many = Array.from({ length: MAX_DOCUMENTS + 5 }, (_, i) => ({ url: `https://doc-${i}.com` }));
    const store = createMockStore({ urlsByQuery: { q: many }, docText: () => 'tiny' });
    const { urls } = await assembleReferenceDocuments(['q'], store);
    expect(urls).toHaveLength(MAX_DOCUMENTS);
  });

  it('truncates the boundary document and stops adding lower-ranked ones', async () => {
    // Each ~60% of budget: the first fits, the second crosses the boundary
    // (truncated), and the third must never be reached.
    const big = 'X'.repeat(Math.floor(MAX_REFERENCE_CHARS * 0.6));
    const store = createMockStore({
      urlsByQuery: { q: [{ url: 'https://1.com' }, { url: 'https://2.com' }, { url: 'https://3.com' }] },
      docText: () => big,
    });
    const { text } = await assembleReferenceDocuments(['q'], store);
    expect(text).toContain('### Source: https://1.com');
    expect(text).toContain('[TRUNCATED]');
    expect(text).not.toContain('### Source: https://3.com');
  });

  it('keeps the assembled text within the character budget', async () => {
    const big = 'Y'.repeat(MAX_REFERENCE_CHARS * 2);
    const store = createMockStore({
      urlsByQuery: { q: [{ url: 'https://huge.com' }] },
      docText: () => big,
    });
    const { text } = await assembleReferenceDocuments(['q'], store);
    expect(text.length).toBeLessThanOrEqual(MAX_REFERENCE_CHARS + 200);
    expect(text).toContain('[TRUNCATED]');
  });
});

// ---------------------------------------------------------------------------
// Test 3b: Candidate collection (real collectCandidateUrls)
// ---------------------------------------------------------------------------
describe('collectCandidateUrls — ranked candidates with descriptions', () => {
  function storeWithDescriptions(byQuery: Record<string, Array<{ url: string; description?: string; provenance?: string }>>): IKnowledgeStore {
    return {
      findRelevantUrls: vi.fn(async (q: string) =>
        (byQuery[q] ?? []).map((e) => ({ url: e.url, description: e.description ?? '', provenance: e.provenance }))),
    } as unknown as IKnowledgeStore;
  }

  it('captures each URL description and dedups by first appearance', async () => {
    const store = storeWithDescriptions({
      q1: [{ url: 'https://a.com', description: 'About A' }],
      q2: [{ url: 'https://a.com', description: 'A again' }, { url: 'https://b.com', description: 'About B' }],
    });
    const { candidates } = await collectCandidateUrls(['q1', 'q2'], store);
    expect(candidates.map((c) => c.url)).toEqual(['https://a.com', 'https://b.com']);
    // First appearance wins for the description
    expect(candidates[0].description).toBe('About A');
    expect(candidates[1].description).toBe('About B');
  });

  it('caps the candidate pool at MAX_CANDIDATES', async () => {
    const many = Array.from({ length: MAX_CANDIDATES + 8 }, (_, i) => ({ url: `https://d-${i}.com`, description: `d${i}` }));
    const store = storeWithDescriptions({ q: many });
    const { candidates } = await collectCandidateUrls(['q'], store);
    expect(candidates).toHaveLength(MAX_CANDIDATES);
  });

  it('returns an empty list when nothing is found', async () => {
    const { candidates } = await collectCandidateUrls(['q'], storeWithDescriptions({}));
    expect(candidates).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Test 3c: Relevance triage (real triageRelevantUrls, mocked LLM)
// ---------------------------------------------------------------------------
describe('triageRelevantUrls — cheap description-based relevance judgement', () => {
  const model = { maxTokens: 4096 } as any;
  const auth = { apiKey: 'test-key' };
  const cands = (n: number): KnowledgeCandidate[] =>
    Array.from({ length: n }, (_, i) => ({ url: `https://u-${i}.com`, description: `desc ${i}`, provenance: 'p' }));
  const llmReturning = (json: string) => ({ content: [{ type: 'text', text: json }], stopReason: 'stop' });

  beforeEach(() => mockCompleteSimple.mockReset());

  it('maps returned indices to the corresponding candidate URLs', async () => {
    mockCompleteSimple.mockResolvedValue(llmReturning('{"relevant_indices":[0,2]}'));
    const urls = await triageRelevantUrls(model, auth, 'history', ['test query'],cands(3), 30000, 'off');
    expect(urls).toEqual(['https://u-0.com', 'https://u-2.com']);
  });

  it('drops out-of-range and duplicate indices', async () => {
    mockCompleteSimple.mockResolvedValue(llmReturning('{"relevant_indices":[1,1,99,-1,0]}'));
    const urls = await triageRelevantUrls(model, auth, 'history', ['test query'],cands(3), 30000, 'off');
    expect(urls).toEqual(['https://u-1.com', 'https://u-0.com']);
  });

  it('returns [] (authoritative "nothing relevant") when the model selects none', async () => {
    mockCompleteSimple.mockResolvedValue(llmReturning('{"relevant_indices":[]}'));
    const urls = await triageRelevantUrls(model, auth, 'history', ['test query'],cands(3), 30000, 'off');
    expect(urls).toEqual([]);
  });

  it('short-circuits without an LLM call for empty candidates', async () => {
    const urls = await triageRelevantUrls(model, auth, 'history', ['test query'],[], 30000, 'off');
    expect(urls).toEqual([]);
    expect(mockCompleteSimple).not.toHaveBeenCalled();
  });

  it('truncates an over-long candidate description to TRIAGE_DESCRIPTION_MAX_CHARS in the prompt', async () => {
    mockCompleteSimple.mockResolvedValue(llmReturning('{"relevant_indices":[]}'));
    const longDesc = 'x'.repeat(TRIAGE_DESCRIPTION_MAX_CHARS + 500);
    const candidate: KnowledgeCandidate = { url: 'https://long.com', description: longDesc, provenance: 'p' };
    await triageRelevantUrls(model, auth, 'history', ['test query'],[candidate], 30000, 'off');
    const systemPrompt: string = mockCompleteSimple.mock.calls[0][1].systemPrompt;
    // The full description must not appear; the truncated slice must.
    expect(systemPrompt).not.toContain(longDesc);
    expect(systemPrompt).toContain('x'.repeat(TRIAGE_DESCRIPTION_MAX_CHARS));
    expect(systemPrompt).not.toContain('x'.repeat(TRIAGE_DESCRIPTION_MAX_CHARS + 1));
  });

  it('surfaces the explicit search query in the triage prompt so triage is not blind to the question', async () => {
    // Regression: the triage judged relevance ONLY against the conversation history, which
    // is empty in the CLI/SDK/agent-skill paths ("No previous context available.") — leaving
    // the model unable to know the question and returning non-deterministic false "no results".
    // The query must always reach the prompt.
    mockCompleteSimple.mockResolvedValue(llmReturning('{"relevant_indices":[0]}'));
    await triageRelevantUrls(model, auth, 'No previous context available.', ['who created the Rust language'], cands(2), 30000, 'off');
    const systemPrompt: string = mockCompleteSimple.mock.calls[0][1].systemPrompt;
    expect(systemPrompt).toContain("USER'S SEARCH QUERY");
    expect(systemPrompt).toContain('who created the Rust language');
  });

  it('renders multiple queries and neutralizes regex-special `$` sequences in the query', async () => {
    mockCompleteSimple.mockResolvedValue(llmReturning('{"relevant_indices":[]}'));
    await triageRelevantUrls(model, auth, 'history', ['price of $100 item', 'cost $& fees'], cands(1), 30000, 'off');
    const systemPrompt: string = mockCompleteSimple.mock.calls[0][1].systemPrompt;
    expect(systemPrompt).toContain('- price of $100 item');
    expect(systemPrompt).toContain('- cost $& fees'); // literal, not a regex replacement artifact
  });

  it('fails open (null) on malformed model output so real knowledge is never hidden', async () => {
    mockCompleteSimple.mockResolvedValue(llmReturning('not json at all'));
    const urls = await triageRelevantUrls(model, auth, 'history', ['test query'],cands(3), 30000, 'off');
    expect(urls).toBeNull();
  });

  it('fails open (null) on a non-transient LLM error', async () => {
    // Provider surfaces the error via the response (stopReason/errorMessage), which
    // validateAndExtractText turns into a thrown non-transient error inside the try.
    mockCompleteSimple.mockResolvedValue({ stopReason: 'error', errorMessage: 'model does not exist', content: [] });
    const urls = await triageRelevantUrls(model, auth, 'history', ['test query'],cands(3), 30000, 'off');
    expect(urls).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Test 4: Tri-state Steering (real buildSteeringResult)
// ---------------------------------------------------------------------------
describe('buildSteeringResult — tri-state answer steering', () => {
  it('returns the miss string and found:false when answer_status is "no"', () => {
    const out = buildSteeringResult({ answer_status: 'no', synthesis: '', citations: [] }, []);
    const text = (out.content[0] as any).text as string;
    expect(text).toBe(RESEARCH_KNOWLEDGE_MISS_STRING);
    expect((out.details as any).found).toBe(false);
    expect((out.details as any).answerStatus).toBe('no');
  });

  it('returns synthesis + a Sources section + found:true for "yes"', () => {
    const out = buildSteeringResult(
      { answer_status: 'yes', synthesis: 'The sky is blue [1].', citations: ['https://example.com/sky'] },
      ['https://example.com/sky'],
    );
    const text = (out.content[0] as any).text as string;
    expect(text).toContain('The sky is blue [1].');
    expect(text).toContain('### Sources');
    expect(text).toContain('1. https://example.com/sky');
    expect((out.details as any).found).toBe(true);
    expect((out.details as any).answerStatus).toBe('yes');
    expect((out.details as any).documentsSearched).toBe(1);
  });

  it('appends the MAYBE string and reports answerStatus:"maybe"', () => {
    const out = buildSteeringResult(
      { answer_status: 'maybe', synthesis: 'Partial: sky may be blue [1].', citations: ['https://example.com/sky'] },
      ['https://example.com/sky'],
    );
    const text = (out.content[0] as any).text as string;
    expect(text).toContain('Partial: sky may be blue [1].');
    expect(text).toContain(RESEARCH_KNOWLEDGE_MAYBE_STRING);
    expect((out.details as any).answerStatus).toBe('maybe');
  });

  it('omits the Sources section when there are no citations', () => {
    const out = buildSteeringResult({ answer_status: 'yes', synthesis: 'Answer, no citations.', citations: [] }, []);
    const text = (out.content[0] as any).text as string;
    expect(text).toBe('Answer, no citations.');
    expect(text).not.toContain('### Sources');
  });
});

// ---------------------------------------------------------------------------
// Test 5: Model Resolution Priority (real resolveResearchModel)
// ---------------------------------------------------------------------------
describe('resolveResearchModel — resolution priority chain', () => {
  function mockRegistry(
    all: Array<{ id: string; provider: string }>,
    available: Array<{ id: string; provider: string }> = all,
  ): ModelRegistry {
    return { getAll: () => all, getAvailable: () => available } as unknown as ModelRegistry;
  }

  it('prefers an explicit modelId over config and host model', () => {
    const reg = mockRegistry([{ id: 'explicit', provider: 'openai' }, { id: 'ctx', provider: 'openai' }]);
    const m = resolveResearchModel({
      modelRegistry: reg,
      config: { RESEARCH_MODEL: 'ctx' } as any,
      modelId: 'explicit',
      hostModel: { id: 'ctx', provider: 'openai' } as any,
    });
    expect(m.id).toBe('explicit');
  });

  it('uses RESEARCH_MODEL when configured and present in the registry', () => {
    const reg = mockRegistry([{ id: 'research-model', provider: 'openai' }]);
    const m = resolveResearchModel({
      modelRegistry: reg,
      config: { RESEARCH_MODEL: 'research-model' } as any,
      hostModel: { id: 'ctx', provider: 'openai' } as any,
    });
    expect(m.id).toBe('research-model');
  });

  it('matches RESEARCH_MODEL by "provider/id" form', () => {
    const reg = mockRegistry([{ id: 'gpt-4o', provider: 'openai' }]);
    const m = resolveResearchModel({
      modelRegistry: reg,
      config: { RESEARCH_MODEL: 'openai/gpt-4o' } as any,
      hostModel: { id: 'ctx', provider: 'openai' } as any,
    });
    expect(m.id).toBe('gpt-4o');
  });

  it('falls back to the host model when RESEARCH_MODEL is not found', () => {
    const reg = mockRegistry([{ id: 'unrelated', provider: 'openai' }]);
    const m = resolveResearchModel({
      modelRegistry: reg,
      config: { RESEARCH_MODEL: 'missing-model' } as any,
      hostModel: { id: 'ctx', provider: 'openai' } as any,
    });
    expect(m.id).toBe('ctx');
  });

  it('falls back to the first available model when no host model is given', () => {
    const reg = mockRegistry([{ id: 'a', provider: 'openai' }], [{ id: 'a', provider: 'openai' }]);
    const m = resolveResearchModel({ modelRegistry: reg, config: {} as any });
    expect(m.id).toBe('a');
  });

  it('throws when no model can be resolved at all', () => {
    const reg = mockRegistry([], []);
    expect(() => resolveResearchModel({ modelRegistry: reg, config: {} as any })).toThrow(/No LLM model available/);
  });

  // Regression: the same model id registered under multiple providers — one
  // authed (user config) and one keyless (pi built-in). A bare-id match must
  // resolve to the authed provider, never the keyless one. Mirrors the real
  // glm-coding/glm-4.7 (authed) vs zai/glm-4.7 (no key) failure on jdebian.
  it('explicit bare modelId prefers an authed provider over a keyless same-id entry', () => {
    const reg = mockRegistry(
      [{ id: 'glm-4.7', provider: 'zai' }, { id: 'glm-4.7', provider: 'glm-coding' }],
      [{ id: 'glm-4.7', provider: 'glm-coding' }], // only glm-coding has auth
    );
    const m = resolveResearchModel({ modelRegistry: reg, config: {} as any, modelId: 'glm-4.7' });
    expect(m.provider).toBe('glm-coding');
  });

  it('RESEARCH_MODEL bare id prefers an authed provider over a keyless same-id entry', () => {
    const reg = mockRegistry(
      [{ id: 'glm-4.7', provider: 'zai' }, { id: 'glm-4.7', provider: 'glm-coding' }],
      [{ id: 'glm-4.7', provider: 'glm-coding' }],
    );
    const m = resolveResearchModel({
      modelRegistry: reg,
      config: { RESEARCH_MODEL: 'glm-4.7' } as any,
    });
    expect(m.provider).toBe('glm-coding');
  });

  it('an explicit "provider/id" form is honored verbatim even if that provider is keyless', () => {
    const reg = mockRegistry(
      [{ id: 'glm-4.7', provider: 'zai' }, { id: 'glm-4.7', provider: 'glm-coding' }],
      [{ id: 'glm-4.7', provider: 'glm-coding' }],
    );
    const m = resolveResearchModel({
      modelRegistry: reg,
      config: { RESEARCH_MODEL: 'zai/glm-4.7' } as any,
    });
    expect(m.provider).toBe('zai');
  });
});

// ---------------------------------------------------------------------------
// Test 6: Tool Metadata Correctness
// ---------------------------------------------------------------------------
describe('Tool metadata and registration shape', () => {
  it('has the correct tool name', async () => {
    const { createResearchKnowledgeSearchTool } =
      await import('../../../src/tools/research-knowledge-search.ts');
    const tool = createResearchKnowledgeSearchTool();
    expect(tool.name).toBe('research_knowledge_search');
  });

  it('has the correct human-readable label', async () => {
    const { createResearchKnowledgeSearchTool } =
      await import('../../../src/tools/research-knowledge-search.ts');
    const tool = createResearchKnowledgeSearchTool();
    expect(tool.label).toBe('Research Knowledge Search');
  });

  it('has a non-empty description', async () => {
    const { createResearchKnowledgeSearchTool } =
      await import('../../../src/tools/research-knowledge-search.ts');
    const tool = createResearchKnowledgeSearchTool();
    expect(tool.description.length).toBeGreaterThan(20);
  });

  it('has prompt guidelines that reference all three tri-state values', async () => {
    const { createResearchKnowledgeSearchTool } =
      await import('../../../src/tools/research-knowledge-search.ts');
    const tool = createResearchKnowledgeSearchTool();
    expect(tool.promptGuidelines).toBeDefined();
    const guidelines = tool.promptGuidelines!.join(' ');
    expect(guidelines).toContain('"yes"');
    expect(guidelines).toContain('"maybe"');
    expect(guidelines).toContain('"no"');
  });

  it('has parameters schema with queries array', async () => {
    const { createResearchKnowledgeSearchTool } =
      await import('../../../src/tools/research-knowledge-search.ts');
    const tool = createResearchKnowledgeSearchTool();
    expect((tool.parameters as any).type).toBe('object');
  });

  it('has an execute function', async () => {
    const { createResearchKnowledgeSearchTool } =
      await import('../../../src/tools/research-knowledge-search.ts');
    const tool = createResearchKnowledgeSearchTool();
    expect(typeof tool.execute).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Test 7: Knowledge Search TUI Panel
// ---------------------------------------------------------------------------
describe('Knowledge Search TUI Panel', () => {
  it('renders a 3-row bordered box with searching message', async () => {
    const { createKnowledgeSearchPanel } = await import('../../../src/tui/knowledge-search-panel.ts');
    const mockTheme = { fg: (_color: any, text: string) => text };
    const factory = createKnowledgeSearchPanel();
    const component = factory({}, mockTheme as any);
    const lines = component.render(40);

    expect(lines).toHaveLength(3);
    expect(lines[0]!).toBe('┌' + '─'.repeat(38) + '┐');
    expect(lines[1]).toContain('searching knowledge store');
    expect(lines[1]!.startsWith('│')).toBe(true);
    expect(lines[1]!.endsWith('│')).toBe(true);
    expect(lines[2]).toBe('└' + '─'.repeat(38) + '┘');
  });

  it('centers the message within the box', async () => {
    const { createKnowledgeSearchPanel } = await import('../../../src/tui/knowledge-search-panel.ts');
    const mockTheme = { fg: (_color: any, text: string) => text };
    const factory = createKnowledgeSearchPanel();
    const component = factory({}, mockTheme as any);
    const lines = component.render(40);

    const inner = lines[1]!.slice(1, -1); // strip the │ borders
    expect(inner.length).toBe(38); // full inner width preserved
    const leftPad = inner.length - inner.trimStart().length;
    const rightPad = inner.length - inner.trimEnd().length;
    // Balanced to within one space (odd leftover padding goes to the right)
    expect(Math.abs(leftPad - rightPad)).toBeLessThanOrEqual(1);
    expect(leftPad).toBeGreaterThan(0);
    expect(inner.trim()).toBe('searching knowledge store');
  });

  it('returns empty for very narrow terminals', async () => {
    const { createKnowledgeSearchPanel } = await import('../../../src/tui/knowledge-search-panel.ts');
    const mockTheme = { fg: (_color: any, text: string) => text };
    const factory = createKnowledgeSearchPanel();
    const component = factory({}, mockTheme as any);
    expect(component.render(3)).toEqual([]);
  });

  it('truncates message when terminal is narrow', async () => {
    const { createKnowledgeSearchPanel } = await import('../../../src/tui/knowledge-search-panel.ts');
    const mockTheme = { fg: (_color: any, text: string) => text };
    const factory = createKnowledgeSearchPanel();
    const component = factory({}, mockTheme as any);
    const lines = component.render(10);
    expect(lines).toHaveLength(3);
    const innerContent = lines[1]!.slice(1, -1);
    // truncateToWidth embeds ANSI resets around its ellipsis, so the raw string
    // length can exceed the column count — assert the *visible* width fills the
    // box (innerWidth = 10 - 2 borders = 8) and stays within it.
    const visible = innerContent.replace(/\x1b\[[0-9;]*m/g, '');
    expect(visible.length).toBe(8);
    // Top/bottom borders must match the same inner width so the box is square.
    expect(lines[0]).toBe('┌' + '─'.repeat(8) + '┐');
    expect(lines[2]).toBe('└' + '─'.repeat(8) + '┘');
  });
});

// ---------------------------------------------------------------------------
// execute() parameter validation — defensive Value.Check (same pattern as the
// sibling search/scrape/security tools)
// ---------------------------------------------------------------------------
describe('research_knowledge_search execute — parameter validation', () => {
  it('rejects a string `queries` (would otherwise iterate per-character)', async () => {
    const tool = createResearchKnowledgeSearchTool();
    const result = await tool.execute(
      'test-id',
      { queries: 'what is quantum computing' } as any,
      undefined,
      undefined as any,
      {} as any,
    );
    expect(result.details).toMatchObject({ error: 'invalid_parameters' });
    expect((result.content[0] as any).text).toContain('Invalid parameters');
  });

  it('rejects missing queries', async () => {
    const tool = createResearchKnowledgeSearchTool();
    const result = await tool.execute('test-id', {} as any, undefined, undefined as any, {} as any);
    expect(result.details).toMatchObject({ error: 'invalid_parameters' });
  });

  it('rejects more than 5 queries', async () => {
    const tool = createResearchKnowledgeSearchTool();
    const result = await tool.execute(
      'test-id',
      { queries: ['a', 'b', 'c', 'd', 'e', 'f'] } as any,
      undefined,
      undefined as any,
      {} as any,
    );
    expect(result.details).toMatchObject({ error: 'invalid_parameters' });
  });
});
