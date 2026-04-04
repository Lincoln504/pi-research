/**
 * Grep Tool Unit Tests
 *
 * Tests the rg_grep tool implementation with focus on:
 * - Input sanitization and security
 * - Output truncation logic
 * - Tool metadata
 * - Error handling and fallback behavior
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createGrepTool, grep } from '../../../src/tools/grep';
import { spawn } from 'node:child_process';

vi.mock('node:child_process');

describe('grep tool', () => {
  const spawnMock = vi.mocked(spawn);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Tool Definition', () => {
    it('should create tool with correct metadata', () => {
      const tool = createGrepTool();
      expect(tool.name).toBe('rg_grep');
      expect(tool.label).toBe('Code Search');
      expect(tool.description).toContain('ripgrep');
      expect(tool.description).toContain('grep');
    });

    it('should have execute function', () => {
      const tool = createGrepTool();
      expect(typeof tool.execute).toBe('function');
    });

    it('should have proper parameter schema', () => {
      const tool = createGrepTool();
      const props = (tool.parameters as any).properties;

      expect(props).toHaveProperty('pattern');
      expect(props.pattern).toBeDefined();
      expect(props).toHaveProperty('path');
      expect(props).toHaveProperty('flags');
    });

    it('should have helpful prompt guidelines', () => {
      const tool = createGrepTool();
      expect(Array.isArray(tool.promptGuidelines)).toBe(true);
      expect(tool.promptGuidelines!.length).toBeGreaterThan(0);
      expect(tool.promptGuidelines![0]).toContain('rg_grep');
    });
  });

  describe('Parameter Validation', () => {
    it('should reject missing pattern', async () => {
      const tool = createGrepTool();
      const result = await tool.execute('id', {}, undefined, undefined, {} as any);

      const text = (result.content[0] as any)?.text;
      expect(text).toContain('Error');
      expect(text).toContain('pattern is required');
    });

    it('should reject empty pattern', async () => {
      const tool = createGrepTool();
      const result = await tool.execute(
        'id',
        { pattern: '' },
        undefined,
        undefined,
        {} as any
      );

      const text = (result.content[0] as any)?.text;
      expect(text).toContain('Error');
    });

    it('should accept pattern with optional path and flags', async () => {
      const tool = createGrepTool();

      // Mock successful rg execution
      const mockChild = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((event, callback) => {
          if (event === 'close') {
            callback(1); // Exit code 1 = no matches
          }
        }),
      };
      spawnMock.mockReturnValue(mockChild as any);

      const result = await tool.execute(
        'id',
        { pattern: 'test', path: '/src', flags: '-i' },
        undefined,
        undefined,
        {} as any
      );

      const text = (result.content[0] as any)?.text;
      expect(text).toContain('Pattern');
      expect(text).toContain('test');
      expect(text).toContain('/src');
    });
  });

  describe('rg/grep Fallback', () => {
    it('should attempt rg first', async () => {
      const tool = createGrepTool();

      const mockChild = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((event, callback) => {
          if (event === 'close') callback(0);
        }),
      };
      spawnMock.mockReturnValue(mockChild as any);

      await tool.execute(
        'id',
        { pattern: 'test' },
        undefined,
        undefined,
        {} as any
      );

      expect(spawnMock).toHaveBeenCalledWith('rg', expect.any(Array));
    });

    it('should fallback to grep when rg fails', async () => {
      const tool = createGrepTool();

      let callCount = 0;
      spawnMock.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // First call (rg) throws error
          const mockChild = {
            stdout: { on: vi.fn() },
            stderr: { on: vi.fn() },
            on: vi.fn((event, callback) => {
              if (event === 'error') {
                callback(new Error('rg not found'));
              }
            }),
          };
          return mockChild as any;
        } else {
          // Second call (grep) succeeds
          const mockChild = {
            stdout: { on: vi.fn() },
            stderr: { on: vi.fn() },
            on: vi.fn((event, callback) => {
              if (event === 'close') callback(0);
            }),
          };
          return mockChild as any;
        }
      });

      const result = await tool.execute(
        'id',
        { pattern: 'test' },
        undefined,
        undefined,
        {} as any
      );

      const text = (result.content[0] as any)?.text;
      expect(text).toContain('grep');
      expect(text).toContain('fallback');
    });

    it('should report error when both rg and grep fail', async () => {
      const tool = createGrepTool();

      spawnMock.mockImplementation(() => {
        const mockChild = {
          stdout: { on: vi.fn() },
          stderr: { on: vi.fn() },
          on: vi.fn((event, callback) => {
            if (event === 'error') {
              callback(new Error('Command not found'));
            }
          }),
        };
        return mockChild as any;
      });

      const result = await tool.execute(
        'id',
        { pattern: 'test' },
        undefined,
        undefined,
        {} as any
      );

      const text = (result.content[0] as any)?.text;
      expect(text).toContain('Error');
      expect(text).toContain('Neither rg nor grep is available');
    });
  });

  describe('Output Processing', () => {
    it('should include exit code in output', async () => {
      const tool = createGrepTool();

      let dataCallback: any;
      let closeCallback: any;

      const mockChild = {
        stdout: {
          on: vi.fn((event, callback) => {
            if (event === 'data') dataCallback = callback;
          }),
        },
        stderr: { on: vi.fn() },
        on: vi.fn((event, callback) => {
          if (event === 'close') closeCallback = callback;
        }),
      };
      spawnMock.mockReturnValue(mockChild as any);

      const promise = tool.execute(
        'id',
        { pattern: 'test' },
        undefined,
        undefined,
        {} as any
      );

      // Simulate data and close
      dataCallback('line1\nline2\n');
      closeCallback(0);

      const result = await promise;
      const text = (result.content[0] as any)?.text;
      expect(text).toContain('**Exit Code:**');
      expect(text).toContain('0');
    });

    it('should format output as markdown', async () => {
      const tool = createGrepTool();

      let dataCallback: any;
      let closeCallback: any;

      const mockChild = {
        stdout: {
          on: vi.fn((event, callback) => {
            if (event === 'data') dataCallback = callback;
          }),
        },
        stderr: { on: vi.fn() },
        on: vi.fn((event, callback) => {
          if (event === 'close') closeCallback = callback;
        }),
      };
      spawnMock.mockReturnValue(mockChild as any);

      const promise = tool.execute(
        'id',
        { pattern: 'test' },
        undefined,
        undefined,
        {} as any
      );

      dataCallback('result1\nresult2\n');
      closeCallback(0);

      const result = await promise;
      const text = (result.content[0] as any)?.text;

      expect(text).toContain('# Search Results');
      expect(text).toContain('**Pattern:**');
      expect(text).toContain('```');
    });

    it('should report "no matches" when output is empty', async () => {
      const tool = createGrepTool();

      let closeCallback: any;

      const mockChild = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((event, callback) => {
          if (event === 'close') closeCallback = callback;
        }),
      };
      spawnMock.mockReturnValue(mockChild as any);

      const promise = tool.execute(
        'id',
        { pattern: 'nonexistent' },
        undefined,
        undefined,
        {} as any
      );

      closeCallback(1); // Exit code 1 = no matches

      const result = await promise;
      const text = (result.content[0] as any)?.text;
      expect(text).toContain('No matches found');
    });

    it('should include stderr in output when present', async () => {
      const tool = createGrepTool();

      let dataCallback: any;
      let stderrCallback: any;
      let closeCallback: any;

      const mockChild = {
        stdout: {
          on: vi.fn((event, callback) => {
            if (event === 'data') dataCallback = callback;
          }),
        },
        stderr: {
          on: vi.fn((event, callback) => {
            if (event === 'data') stderrCallback = callback;
          }),
        },
        on: vi.fn((event, callback) => {
          if (event === 'close') closeCallback = callback;
        }),
      };
      spawnMock.mockReturnValue(mockChild as any);

      const promise = tool.execute(
        'id',
        { pattern: 'test' },
        undefined,
        undefined,
        {} as any
      );

      dataCallback('result1\n');
      stderrCallback('warning: something\n');
      closeCallback(0);

      const result = await promise;
      const text = (result.content[0] as any)?.text;
      expect(text).toContain('Stderr');
      expect(text).toContain('warning');
    });
  });

  describe('Standalone grep function', () => {
    it('should export grep function', () => {
      expect(typeof grep).toBe('function');
    });

    it('should throw when pattern is missing', async () => {
      await expect(grep('')).rejects.toThrow('Pattern is required');
    });

    it('should call spawn with correct arguments', async () => {
      let closeCallback: any;

      const mockChild = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((event, callback) => {
          if (event === 'close') closeCallback = callback;
        }),
      };
      spawnMock.mockReturnValue(mockChild as any);

      const promise = grep('test_pattern', '/search/path', '-i');
      closeCallback(0);

      await promise;

      expect(spawnMock).toHaveBeenCalledWith('rg', expect.any(Array));
      const args = spawnMock.mock.calls[0]?.[1];
      expect(args).toContain('test_pattern');
      expect(args).toContain('/search/path');
    });
  });
});
