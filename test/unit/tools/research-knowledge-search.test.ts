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

import { describe, it, expect, vi } from 'vitest';
import { Value } from 'typebox/value';
import {
  ResearchKnowledgeSynthesisResponseSchema,
} from '../../../src/tools/research-knowledge-types.ts';
import {
  assembleReferenceDocuments,
  buildSteeringResult,
  MAX_DOCUMENTS,
  MAX_REFERENCE_CHARS,
  RESEARCH_KNOWLEDGE_MISS_STRING,
  RESEARCH_KNOWLEDGE_MAYBE_STRING,
} from '../../../src/tools/research-knowledge-search.ts';
import { resolveResearchModel } from '../../../src/core/llm/research-model-resolver.ts';
import type { IKnowledgeStore } from '../../../src/core/interfaces/knowledge-interfaces.ts';
import type { ModelRegistry } from '@earendil-works/pi-coding-agent';

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
    expect(innerContent.length).toBe(8);
  });
});
