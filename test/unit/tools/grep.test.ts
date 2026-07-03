import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createGrepTool } from '../../../src/tools/grep.ts';
import { ToolUsageTracker } from '../../../src/utils/tool-usage-tracker.ts';

describe('tools/grep', () => {
  const createMockTracker = () => new ToolUsageTracker({ gathering: 6 });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates tool with correct metadata', () => {
    const tool = createGrepTool({ tracker: createMockTracker() });
    expect(tool.name).toBe('grep');
    expect(tool.label).toBe('Code Search');
  });

  it('records call in tracker on each execution', async () => {
    const tracker = createMockTracker();
    const spy = vi.spyOn(tracker, 'recordCall');
    const tool = createGrepTool({ tracker });
    await tool.execute('id', { pattern: 'createGrepTool', path: 'src/tools/grep.ts' }, undefined, undefined, {} as any);
    expect(spy).toHaveBeenCalledWith('grep');
  });

  it('returns limit-reached block when its own grep budget is exceeded', async () => {
    // grep has a dedicated budget, separate from the shared gathering pool.
    const tracker = new ToolUsageTracker({ grep: 1 });
    tracker.recordCall('grep');
    const tool = createGrepTool({ tracker });
    const result = await tool.execute('id', { pattern: 'x' }, undefined, undefined, {} as any);
    expect(result.details).toMatchObject({ blocked: true, reason: 'limit_reached' });
    expect((result.content[0] as any).text).toContain('CODE SEARCH LIMIT REACHED');
  });

  it('is NOT blocked by an exhausted gathering budget (grep is local/free)', async () => {
    const tracker = new ToolUsageTracker({ gathering: 1, grep: 30 });
    tracker.recordCall('search'); // exhausts the gathering pool
    const tool = createGrepTool({ tracker });
    const result = await tool.execute(
      'id',
      { pattern: 'createGrepTool', path: 'src/tools/grep.ts' },
      undefined,
      undefined,
      {} as any,
    );
    expect(result.details).not.toMatchObject({ blocked: true });
    expect((result.content[0] as any).text).toContain('createGrepTool');
  });

  it('returns error for invalid parameters', async () => {
    const tool = createGrepTool({ tracker: createMockTracker() });
    const result = await tool.execute('id', { notAPattern: 'x' }, undefined, undefined, {} as any);
    expect((result.content[0] as any).text).toContain('Invalid parameters');
  });

  it('executes a real search and returns matching content', async () => {
    const tool = createGrepTool({ tracker: createMockTracker() });
    const result = await tool.execute(
      'id',
      { pattern: 'createGrepTool', path: 'src/tools/grep.ts' },
      undefined,
      undefined,
      {} as any,
    );
    expect((result.content[0] as any).text).toContain('createGrepTool');
  });
});
