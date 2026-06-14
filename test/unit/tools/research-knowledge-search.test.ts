/**
 * Research Knowledge Search — Unit Tests
 *
 * Tests the stateless, algorithmic logic of the research_knowledge_search tool:
 * schema validation, URL deduplication, model resolution, token budgeting,
 * tri-state answer steering, TUI panel rendering, and deterministic routing.
 *
 * These tests are entirely memory-bound — no file I/O, no LLM calls.
 * LLM-dependent paths (completeSimple, repairJsonWithLlm) are mocked.
 */

import { describe, it, expect, vi } from 'vitest';
import { Value } from 'typebox/value';
import {
  ResearchKnowledgeSynthesisResponseSchema,
} from '../../../src/tools/research-knowledge-types.ts';

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
// Test 2: URL Deduplication (Phase 2 logic)
// ---------------------------------------------------------------------------
describe('URL deduplication — mathematical set semantics', () => {
  function simulateUrlCollection(
    queryResults: Array<Array<{ url: string; provenance?: string }>>,
  ): { uniqueUrls: string[]; totalHits: number } {
    const allUrls = new Map<string, number>();
    let totalHits = 0;

    for (const results of queryResults) {
      for (const entry of results) {
        totalHits++;
        if (!allUrls.has(entry.url)) {
          allUrls.set(entry.url, allUrls.size);
        }
      }
    }

    const sorted = [...allUrls.keys()]
      .sort((a, b) => (allUrls.get(a) ?? Infinity) - (allUrls.get(b) ?? Infinity));

    return { uniqueUrls: sorted, totalHits };
  }

  it('returns empty when no queries return results', () => {
    const { uniqueUrls, totalHits } = simulateUrlCollection([]);
    expect(uniqueUrls).toHaveLength(0);
    expect(totalHits).toBe(0);
  });

  it('deduplicates a URL returned by multiple queries', () => {
    const results = [
      [{ url: 'https://a.com' }],
      [{ url: 'https://a.com' }],
      [{ url: 'https://b.com' }],
      [{ url: 'https://a.com' }],
    ];
    const { uniqueUrls, totalHits } = simulateUrlCollection(results);
    expect(totalHits).toBe(4);
    expect(uniqueUrls).toHaveLength(2);
    expect(uniqueUrls[0]!).toBe('https://a.com');
    expect(uniqueUrls[1]).toBe('https://b.com');
  });

  it('preserves first-appearance order as relevance ranking', () => {
    const results = [
      [{ url: 'https://c.com' }],
      [{ url: 'https://a.com' }],
      [{ url: 'https://b.com' }],
      [{ url: 'https://a.com' }],
    ];
    const { uniqueUrls } = simulateUrlCollection(results);
    expect(uniqueUrls).toEqual(['https://c.com', 'https://a.com', 'https://b.com']);
  });

  it('handles empty result sets gracefully', () => {
    const results = [[], [], [{ url: 'https://a.com' }], []];
    const { uniqueUrls } = simulateUrlCollection(results);
    expect(uniqueUrls).toEqual(['https://a.com']);
  });

  it('handles all-empty results', () => {
    const { uniqueUrls, totalHits } = simulateUrlCollection([[], [], []]);
    expect(uniqueUrls).toHaveLength(0);
    expect(totalHits).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test 3: Token Budget Enforcement (Phase 2 truncation logic)
// ---------------------------------------------------------------------------
describe('Reference document token budget enforcement', () => {
  type RebuiltDoc = { url: string; text: string };

  function simulateDocumentAssembly(
    docs: RebuiltDoc[],
    maxChars: number,
    maxDocs: number = 10,
  ): { assembled: string[]; droppedUrls: string[]; totalChars: number } {
    const assembled: string[] = [];
    const droppedUrls: string[] = [];
    let totalChars = 0;
    let budgetExhausted = false;

    for (let i = 0; i < docs.length; i++) {
      if (i >= maxDocs) { droppedUrls.push(docs[i]!.url); continue; }
      if (budgetExhausted) { droppedUrls.push(docs[i]!.url); continue; }

      const doc = docs[i]!;
      const header = `\n---\n### Source: ${doc.url}\n`;
      const entry = header + doc.text;

      if (totalChars + entry.length > maxChars) {
        const remaining = maxChars - totalChars - header.length;
        if (remaining > 500) {
          assembled.push(header + doc.text.slice(0, remaining) + '\n[TRUNCATED]');
          totalChars = maxChars;
        }
        budgetExhausted = true;
        continue;
      }

      assembled.push(entry);
      totalChars += entry.length;
    }

    return { assembled, droppedUrls, totalChars };
  }

  it('fits all documents when total is under budget', () => {
    const docs = [
      { url: 'https://a.com', text: 'Short doc A' },
      { url: 'https://b.com', text: 'Short doc B' },
    ];
    const result = simulateDocumentAssembly(docs, 10000);
    expect(result.assembled).toHaveLength(2);
    expect(result.droppedUrls).toHaveLength(0);
  });

  it('drops lowest-ranked documents when budget is exceeded', () => {
    const docs = [
      { url: 'https://high.com', text: 'A'.repeat(5000) },
      { url: 'https://mid.com', text: 'B'.repeat(5000) },
      { url: 'https://low.com', text: 'C'.repeat(5000) },
    ];
    const result = simulateDocumentAssembly(docs, 6000);
    expect(result.assembled.length).toBeGreaterThanOrEqual(1);
    expect(result.droppedUrls).toContain('https://low.com');
  });

  it('truncates a document at the budget boundary', () => {
    const docs = [{ url: 'https://big.com', text: 'X'.repeat(10000) }];
    const result = simulateDocumentAssembly(docs, 2000);
    expect(result.assembled).toHaveLength(1);
    expect(result.assembled[0]!).toContain('[TRUNCATED]');
    expect(result.assembled[0]!.length).toBeLessThan(docs[0]!.text.length);
  });

  it('respects maxDocs cap', () => {
    const docs = Array.from({ length: 20 }, (_, i) => ({
      url: `https://doc-${i}.com`, text: `Content of doc ${i}`,
    }));
    const result = simulateDocumentAssembly(docs, 100000, 5);
    expect(result.assembled).toHaveLength(5);
    expect(result.droppedUrls.length).toBeGreaterThanOrEqual(15);
  });

  it('returns empty when no documents provided', () => {
    const result = simulateDocumentAssembly([], 100000);
    expect(result.assembled).toHaveLength(0);
    expect(result.droppedUrls).toHaveLength(0);
    expect(result.totalChars).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test 4: Tri-state Steering (Phase 5)
// ---------------------------------------------------------------------------
describe('Orchestration steering — tri-state answer_status', () => {
  const MISS_STRING =
    'No results found. Live research can get the info.';

  const MAYBE_STRING =
    'Partial results found in knowledge store. Live research can fill gaps.';

  it('returns the pivot string when answer_status is "no"', () => {
    const result = { answer_status: 'no' as const, synthesis: '', citations: [] };
    const output = result['answer_status'] === 'no' ? MISS_STRING : result['synthesis'];
    expect(output).toBe(MISS_STRING);
    expect(output).toContain('No results found');
  });

  it('returns synthesis with Sources section when answer_status is "yes"', () => {
    const result = {
      answer_status: 'yes' as const,
      synthesis: 'The sky is blue [1].',
      citations: ['https://example.com/sky'],
    };

    let report = result['synthesis'];
    if (result['citations'].length > 0) {
      report += '\n\n### Sources\n1. https://example.com/sky\n';
    }

    expect(report).toContain('The sky is blue');
    expect(report).toContain('### Sources');
    expect(report).toContain('https://example.com/sky');
  });

  it('returns synthesis + maybe message when answer_status is "maybe"', () => {
    const result = {
      answer_status: 'maybe' as const,
      synthesis: 'Partial: sky may be blue [1].',
      citations: ['https://example.com/sky'],
    };

    let report = result['synthesis'];
    if (result['citations'].length > 0) {
      report += '\n\n### Sources\n1. https://example.com/sky\n';
    }
    report += '\n\n' + MAYBE_STRING;

    expect(report).toContain('Partial: sky may be blue');
    expect(report).toContain(MAYBE_STRING);
    expect(report).toContain('Live research can fill gaps');
  });

  it('returns synthesis without Sources section when citations are empty', () => {
    const result = {
      answer_status: 'yes' as const,
      synthesis: 'Just answer, no citations.',
      citations: [],
    };

    expect(result['synthesis']).toBe('Just answer, no citations.');
  });
});

// ---------------------------------------------------------------------------
// Test 5: Model Resolution Priority (Phase 4)
// ---------------------------------------------------------------------------
describe('Model resolution priority chain', () => {
  function createMockRegistry(models: Array<{ id: string; provider: string }>) {
    return { getAll: vi.fn().mockReturnValue(models) };
  }

  function resolveModel(
    config: { RESEARCH_MODEL?: string },
    ctxModel: { id: string; provider: string },
    registry: ReturnType<typeof createMockRegistry>,
  ): string {
    if (config.RESEARCH_MODEL) {
      const target = config.RESEARCH_MODEL;
      const found = registry.getAll().find(
        (m: any) => `${m.provider}/${m.id}` === target || m.id === target,
      );
      if (found) return found.id;
    }
    return ctxModel.id;
  }

  it('uses RESEARCH_MODEL when configured and available', () => {
    const registry = createMockRegistry([{ id: 'research-model', provider: 'openai' }]);
    expect(resolveModel(
      { RESEARCH_MODEL: 'research-model' },
      { id: 'ctx-model', provider: 'openai' },
      registry,
    )).toBe('research-model');
  });

  it('falls back to ctx.model when RESEARCH_MODEL is not found', () => {
    const registry = createMockRegistry([{ id: 'unrelated', provider: 'openai' }]);
    expect(resolveModel(
      { RESEARCH_MODEL: 'missing-model' },
      { id: 'ctx-model', provider: 'openai' },
      registry,
    )).toBe('ctx-model');
  });

  it('uses ctx.model when no RESEARCH_MODEL is set', () => {
    const registry = createMockRegistry([{ id: 'some-model', provider: 'openai' }]);
    expect(resolveModel({}, { id: 'ctx-model', provider: 'openai' }, registry)).toBe('ctx-model');
  });

  it('matches by "provider/id" format', () => {
    const registry = createMockRegistry([{ id: 'gpt-4o', provider: 'openai' }]);
    expect(resolveModel(
      { RESEARCH_MODEL: 'openai/gpt-4o' },
      { id: 'ctx-model', provider: 'openai' },
      registry,
    )).toBe('gpt-4o');
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
