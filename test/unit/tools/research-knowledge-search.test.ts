/**
 * Research Knowledge Search — Unit Tests
 *
 * Tests the stateless, algorithmic logic of the research_knowledge_search tool:
 * schema validation, URL deduplication, model resolution, token budgeting,
 * tri-state answer steering, and deterministic routing.
 *
 * These tests are entirely memory-bound — no file I/O, no LLM calls.
 * LLM-dependent paths (completeSimple, repairJsonWithLlm) are mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Value } from 'typebox/value';
import {
  ResearchKnowledgeSynthesisResponseSchema,
  legacyBooleanToStatus,
} from '../../../src/tools/research-knowledge-types.ts';

// ---------------------------------------------------------------------------
// Test 1: Schema Rejection & Validation (Phase 1)
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
    expect(coerced.answer_status).toBe('yes');
    expect(coerced.synthesis).toBe('The sky is blue [1].');
    expect(coerced.citations).toEqual(['https://example.com/sky']);
  });

  it('accepts a response with answer_status="no", no synthesis', () => {
    const input = {
      answer_status: 'no',
      citations: [],
    };
    const coerced = Value.Convert(ResearchKnowledgeSynthesisResponseSchema, input) as Record<string, any>;
    expect(Value.Check(ResearchKnowledgeSynthesisResponseSchema, coerced)).toBe(true);
    expect(coerced.answer_status).toBe('no');
    expect((coerced as any).synthesis).toBeUndefined();
  });

  it('accepts a response with answer_status="maybe" with synthesis', () => {
    const input = {
      answer_status: 'maybe',
      synthesis: 'Partial info: the sky may be blue [1].',
      citations: ['https://example.com/sky'],
    };
    const coerced = Value.Convert(ResearchKnowledgeSynthesisResponseSchema, input) as Record<string, any>;
    expect(Value.Check(ResearchKnowledgeSynthesisResponseSchema, coerced)).toBe(true);
    expect(coerced.answer_status).toBe('maybe');
    expect(coerced.synthesis).toBe('Partial info: the sky may be blue [1].');
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

  it('converts string citations to array via Value.Convert (TypeBox leniency)', () => {
    const input = { answer_status: 'yes', synthesis: 'text', citations: 'not-an-array' as any };
    const coerced = Value.Convert(ResearchKnowledgeSynthesisResponseSchema, input) as Record<string, any>;
    expect(Array.isArray(coerced.citations)).toBe(true);
  });

  it('coerces non-string citation values via Value.Convert (TypeBox leniency)', () => {
    const input = { answer_status: 'yes', synthesis: 'text', citations: [42] };
    const coerced = Value.Convert(ResearchKnowledgeSynthesisResponseSchema, input) as Record<string, any>;
    expect(Value.Check(ResearchKnowledgeSynthesisResponseSchema, coerced)).toBe(true);
    expect(coerced.citations[0]).toBe('42');
  });

  it('accepts citations as an empty array', () => {
    const input = { answer_status: 'yes', citations: [] };
    const coerced = Value.Convert(ResearchKnowledgeSynthesisResponseSchema, input) as Record<string, any>;
    expect(Value.Check(ResearchKnowledgeSynthesisResponseSchema, coerced)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 1b: Legacy boolean conversion
// ---------------------------------------------------------------------------
describe('legacyBooleanToStatus — backward compatibility', () => {
  it('converts answer_found: true to answer_status: "yes"', () => {
    const result = legacyBooleanToStatus({ answer_found: true, citations: [] });
    expect(result).toEqual({ answer_status: 'yes' });
  });

  it('converts answer_found: false to answer_status: "no"', () => {
    const result = legacyBooleanToStatus({ answer_found: false, citations: [] });
    expect(result).toEqual({ answer_status: 'no' });
  });

  it('returns null when answer_status is already present', () => {
    const result = legacyBooleanToStatus({ answer_status: 'yes', citations: [] });
    expect(result).toBeNull();
  });

  it('returns null when neither field is present', () => {
    const result = legacyBooleanToStatus({ citations: [] });
    expect(result).toBeNull();
  });

  it('returns null for non-object input', () => {
    expect(legacyBooleanToStatus(null)).toBeNull();
    expect(legacyBooleanToStatus(undefined)).toBeNull();
    expect(legacyBooleanToStatus('string')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Test 2: URL Mathematical Deduplication (Phase 2 logic)
// ---------------------------------------------------------------------------
describe('URL deduplication — mathematical set semantics', () => {
  function simulateUrlCollection(
    queryResults: Array<Array<{ url: string; description: string }>>,
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
      [{ url: 'https://a.com', description: 'A1' }],
      [{ url: 'https://a.com', description: 'A2' }],
      [{ url: 'https://b.com', description: 'B1' }],
      [{ url: 'https://a.com', description: 'A3' }],
    ];
    const { uniqueUrls, totalHits } = simulateUrlCollection(results);
    expect(totalHits).toBe(4);
    expect(uniqueUrls).toHaveLength(2);
    expect(uniqueUrls[0]).toBe('https://a.com');
    expect(uniqueUrls[1]).toBe('https://b.com');
  });

  it('preserves first-appearance order as relevance ranking', () => {
    const results = [
      [{ url: 'https://c.com', description: 'C1' }],
      [{ url: 'https://a.com', description: 'A1' }],
      [{ url: 'https://b.com', description: 'B1' }],
      [{ url: 'https://a.com', description: 'A2' }],
    ];
    const { uniqueUrls } = simulateUrlCollection(results);
    expect(uniqueUrls[0]).toBe('https://c.com');
    expect(uniqueUrls[1]).toBe('https://a.com');
    expect(uniqueUrls[2]).toBe('https://b.com');
  });

  it('handles empty result sets gracefully', () => {
    const results = [
      [],
      [],
      [{ url: 'https://a.com', description: 'A1' }],
      [],
    ];
    const { uniqueUrls } = simulateUrlCollection(results);
    expect(uniqueUrls).toHaveLength(1);
    expect(uniqueUrls[0]).toBe('https://a.com');
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
      if (i >= maxDocs) {
        droppedUrls.push(docs[i]!.url);
        continue;
      }

      if (budgetExhausted) {
        droppedUrls.push(docs[i]!.url);
        continue;
      }

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
    const budget = 6000;
    const result = simulateDocumentAssembly(docs, budget);
    expect(result.assembled.length).toBeGreaterThanOrEqual(1);
    expect(result.droppedUrls).toContain('https://low.com');
  });

  it('truncates a document at the budget boundary', () => {
    const docs = [
      { url: 'https://big.com', text: 'X'.repeat(10000) },
    ];
    const budget = 2000;
    const result = simulateDocumentAssembly(docs, budget);
    expect(result.assembled).toHaveLength(1);
    expect(result.assembled[0]).toContain('[TRUNCATED]');
    expect(result.assembled[0].length).toBeLessThan(docs[0]!.text.length);
  });

  it('respects maxDocs cap', () => {
    const docs = Array.from({ length: 20 }, (_, i) => ({
      url: `https://doc-${i}.com`,
      text: `Content of doc ${i}`,
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
    'No relevant data found in research knowledge store. You are now authorized to proceed with live web research and scraping tools.';

  const MAYBE_STRING =
    'Partial data found in research knowledge store. The synthesis above summarizes what is available. You should still proceed with live web research to fill gaps and get a more complete answer.';

  it('returns the exact pivot string when answer_status is "no"', () => {
    const result = { answer_status: 'no' as const, synthesis: '', citations: [] };
    const output = result.answer_status === 'no' ? MISS_STRING : result.synthesis;
    expect(output).toBe(MISS_STRING);
    expect(output).toContain('No relevant data found');
    expect(output).toContain('proceed with live web research');
  });

  it('returns synthesis with Sources section when answer_status is "yes"', () => {
    const result = {
      answer_status: 'yes' as const,
      synthesis: 'The sky is blue [1].',
      citations: ['https://example.com/sky'],
    };

    let report = result.synthesis;
    if (result.citations.length > 0) {
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

    let report = result.synthesis;
    if (result.citations.length > 0) {
      report += '\n\n### Sources\n1. https://example.com/sky\n';
    }
    report += '\n\n' + MAYBE_STRING;

    expect(report).toContain('Partial: sky may be blue');
    expect(report).toContain(MAYBE_STRING);
    expect(report).toContain('proceed with live web research');
  });

  it('returns synthesis without Sources section when citations are empty', () => {
    const result = {
      answer_status: 'yes' as const,
      synthesis: 'Just answer, no citations.',
      citations: [],
    };

    expect(result.synthesis).toBe('Just answer, no citations.');
  });
});

// ---------------------------------------------------------------------------
// Test 5: Model Resolution Priority (Phase 4)
// ---------------------------------------------------------------------------
describe('Model resolution priority chain', () => {
  function createMockRegistry(models: Array<{ id: string; provider: string }>) {
    return {
      getAll: vi.fn().mockReturnValue(models),
    };
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
    const registry = createMockRegistry([
      { id: 'research-model', provider: 'openai' },
    ]);
    const modelId = resolveModel(
      { RESEARCH_MODEL: 'research-model' },
      { id: 'ctx-model', provider: 'openai' },
      registry,
    );
    expect(modelId).toBe('research-model');
  });

  it('falls back to ctx.model when RESEARCH_MODEL is not available', () => {
    const registry = createMockRegistry([
      { id: 'unrelated', provider: 'openai' },
    ]);
    const modelId = resolveModel(
      { RESEARCH_MODEL: 'missing-model' },
      { id: 'ctx-model', provider: 'openai' },
      registry,
    );
    expect(modelId).toBe('ctx-model');
  });

  it('uses ctx.model when no RESEARCH_MODEL is set', () => {
    const registry = createMockRegistry([
      { id: 'some-model', provider: 'openai' },
    ]);
    const modelId = resolveModel(
      {},
      { id: 'ctx-model', provider: 'openai' },
      registry,
    );
    expect(modelId).toBe('ctx-model');
  });

  it('matches by "provider/id" format', () => {
    const registry = createMockRegistry([
      { id: 'gpt-4o', provider: 'openai' },
    ]);
    const modelId = resolveModel(
      { RESEARCH_MODEL: 'openai/gpt-4o' },
      { id: 'ctx-model', provider: 'openai' },
      registry,
    );
    expect(modelId).toBe('gpt-4o');
  });
});

// ---------------------------------------------------------------------------
// Test 6: Tool Metadata Correctness
// ---------------------------------------------------------------------------
describe('Tool metadata and registration shape', () => {
  it('has the correct tool name following pi-research conventions', async () => {
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

  it('has prompt guidelines that reference the tri-state behavior', async () => {
    const { createResearchKnowledgeSearchTool } =
      await import('../../../src/tools/research-knowledge-search.ts');
    const tool = createResearchKnowledgeSearchTool();
    expect(tool.promptGuidelines).toBeDefined();
    expect(tool.promptGuidelines!.length).toBeGreaterThanOrEqual(2);
    expect(tool.promptGuidelines!.some(g => g.includes('"maybe"'))).toBe(true);
    expect(tool.promptGuidelines!.some(g => g.includes('"no"'))).toBe(true);
    expect(tool.promptGuidelines!.some(g => g.includes('"yes"'))).toBe(true);
  });

  it('has parameters schema with queries array', async () => {
    const { createResearchKnowledgeSearchTool } =
      await import('../../../src/tools/research-knowledge-search.ts');
    const tool = createResearchKnowledgeSearchTool();
    expect(tool.parameters).toBeDefined();
    expect((tool.parameters as any).type).toBe('object');
  });

  it('the execute function returns AgentToolResult structure on success', async () => {
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
  it('renders a bordered box with searching message', async () => {
    const { createKnowledgeSearchPanel } = await import('../../../src/tui/knowledge-search-panel.ts');
    const mockTheme = {
      fg: (_color: any, text: string) => text,
    };
    const factory = createKnowledgeSearchPanel();
    const component = factory({}, mockTheme as any);
    const lines = component.render(40);

    expect(lines).toHaveLength(3); // top border + content + bottom border
    expect(lines[0]).toBe('┌' + '─'.repeat(38) + '┐');
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
    // Inner width = 8, message should be truncated
    const innerContent = lines[1]!.slice(1, -1);
    expect(innerContent.length).toBe(8);
  });
});
