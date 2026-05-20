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
    await tool.execute('id', { pattern: 'createGrepTool', path: 'src/tools/grep.ts' }, {} as any);
    expect(spy).toHaveBeenCalledWith('grep');
  });

  it('returns limit-reached block when budget exceeded', async () => {
    const tracker = new ToolUsageTracker({ gathering: 1 });
    tracker.recordCall('grep');
    const tool = createGrepTool({ tracker });
    const result = await tool.execute('id', { pattern: 'x' }, {} as any);
    expect(result.details).toMatchObject({ blocked: true, reason: 'limit_reached' });
    expect(result.content[0]!.text).toContain('GATHERING LIMIT REACHED');
  });

  it('returns error for invalid parameters', async () => {
    const tool = createGrepTool({ tracker: createMockTracker() });
    const result = await tool.execute('id', { notAPattern: 'x' }, {} as any);
    expect(result.content[0]!.text).toContain('Invalid parameters');
  });

  it('rejects path traversal outside workspace', async () => {
    const tool = createGrepTool({ tracker: createMockTracker() });
    await expect(
      tool.execute('id', { pattern: 'test', path: '../../../etc/passwd' }, {} as any)
    ).rejects.toThrow('Path outside workspace');
  });

  it('executes a real search and returns matching content', async () => {
    const tool = createGrepTool({ tracker: createMockTracker() });
    // Search for a string that definitely exists in this file's own source
    const result = await tool.execute(
      'id',
      { pattern: 'createGrepTool', path: 'src/tools/grep.ts' },
      {} as any,
    );
    expect(result.content[0]!.text).toContain('createGrepTool');
    expect(result.content[0]!.text).toContain('Exit Code:** 0');
  });
});
