import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSearchTool } from '../../../src/tools/search.ts';
import { ToolUsageTracker } from '../../../src/utils/tool-usage-tracker.ts';

// Mock the search module
vi.mock('../../../src/web-research/search.ts', () => ({
  search: vi.fn(async (queries) => queries.map(q => ({ query: q, results: [] }))),
}));

describe('tools/search', () => {
  let tracker: ToolUsageTracker;
  const mockOptions = {
    ctx: {} as any,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    tracker = new ToolUsageTracker({ gathering: 1 });
  });

  it('should create tool with correct metadata', () => {
    const tool = createSearchTool({ ...mockOptions, tracker });
    expect(tool.name).toBe('search');
    expect(tool.promptGuidelines[0]).toContain('10-150 queries');
  });

  it('should fail if less than 10 queries provided', async () => {
    const tool = createSearchTool({ ...mockOptions, tracker });
    await expect(tool.execute('id', { queries: ['q1'] }, undefined, () => {}, {} as any))
      .rejects.toThrow('Insufficient queries');
  });

  it('should succeed with 10 queries', async () => {
    const tool = createSearchTool({ ...mockOptions, tracker });
    const queries = Array(10).fill('test query');
    const result = await tool.execute('id', { queries }, undefined, () => {}, {} as any);
    expect(result.details).toMatchObject({ queryCount: 10 });
  });

  it('should throw error on second call', async () => {
    const tool = createSearchTool({ ...mockOptions, tracker });
    const queries = Array(10).fill('test query');
    await tool.execute('id1', { queries }, undefined, () => {}, {} as any);

    const result = await tool.execute('id2', { queries }, undefined, () => {}, {} as any);
    expect(result.details).toMatchObject({ blocked: true, reason: 'limit_reached' });
    expect(result.content[0].text).toContain('LIMIT REACHED');
    });
    });

