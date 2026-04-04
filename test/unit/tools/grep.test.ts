/**
 * Grep Tool Unit Tests
 *
 * Tests the rg_grep tool implementation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createGrepTool } from '../../../src/tools/grep';

// Mock child_process to avoid actual command execution
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

describe('grep tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createGrepTool', () => {
    it('should create tool with correct name', () => {
      const tool = createGrepTool();
      expect(tool.name).toBe('rg_grep');
    });

    it('should create tool with correct label', () => {
      const tool = createGrepTool();
      expect(tool.label).toBe('Code Search');
    });

    it('should create tool with description mentioning ripgrep', () => {
      const tool = createGrepTool();
      expect(tool.description.toLowerCase()).toContain('ripgrep');
    });

    it('should create tool with description mentioning grep fallback', () => {
      const tool = createGrepTool();
      expect(tool.description.toLowerCase()).toContain('grep');
    });

    it('should require pattern parameter', () => {
      const tool = createGrepTool();
      expect(tool.parameters).toBeDefined();
      expect(tool.parameters).toHaveProperty('properties');
      expect((tool.parameters as any).properties).toHaveProperty('pattern');
    });

    it('should have optional path parameter', () => {
      const tool = createGrepTool();
      expect((tool.parameters as any).properties).toHaveProperty('path');
    });

    it('should have optional flags parameter', () => {
      const tool = createGrepTool();
      expect((tool.parameters as any).properties).toHaveProperty('flags');
    });

    it('should have execute function', () => {
      const tool = createGrepTool();
      expect(typeof tool.execute).toBe('function');
    });

    it('should have prompt snippet', () => {
      const tool = createGrepTool();
      expect(tool.promptSnippet).toBeDefined();
    });

    it('should have prompt guidelines', () => {
      const tool = createGrepTool();
      expect(tool.promptGuidelines).toBeDefined();
      expect(Array.isArray(tool.promptGuidelines)).toBe(true);
    });
  });

  describe('execute - parameter validation', () => {
    it('should return error when pattern is missing', async () => {
      const tool = createGrepTool();
      const result = await tool.execute('id', {}, undefined, undefined, {} as any);

      expect((result.content[0] as any)?.text).toContain('Error');
      expect((result.content[0] as any)?.text).toContain('pattern is required');
    });

    it('should handle empty pattern', async () => {
      const tool = createGrepTool();
      const result = await tool.execute('id', { pattern: '' }, undefined, undefined, {} as any);

      expect((result.content[0] as any)?.text).toContain('Error');
    });

    it('should accept pattern without path or flags', async () => {
      const tool = createGrepTool();
      const { spawn } = await import('node:child_process');
      const mockChild = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((event, callback) => {
          if (event === 'close') callback(0);
        }),
      };
      vi.mocked(spawn).mockReturnValue(mockChild as any);

      const result = await tool.execute('id', { pattern: 'test' }, undefined, undefined, {} as any);

      expect(result).toBeDefined();
    });

    it('should accept pattern with path', async () => {
      const tool = createGrepTool();
      const { spawn } = await import('node:child_process');
      const mockChild = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((event, callback) => {
          if (event === 'close') callback(0);
        }),
      };
      vi.mocked(spawn).mockReturnValue(mockChild as any);

      const result = await tool.execute('id', { pattern: 'test', path: './src' }, undefined, undefined, {} as any);

      expect(result).toBeDefined();
    });

    it('should accept pattern with flags', async () => {
      const tool = createGrepTool();
      const { spawn } = await import('node:child_process');
      const mockChild = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((event, callback) => {
          if (event === 'close') callback(0);
        }),
      };
      vi.mocked(spawn).mockReturnValue(mockChild as any);

      const result = await tool.execute('id', { pattern: 'test', flags: '-i' }, undefined, undefined, {} as any);

      expect(result).toBeDefined();
    });

    it('should accept all parameters', async () => {
      const tool = createGrepTool();
      const { spawn } = await import('node:child_process');
      const mockChild = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((event, callback) => {
          if (event === 'close') callback(0);
        }),
      };
      vi.mocked(spawn).mockReturnValue(mockChild as any);

      const result = await tool.execute(
        'id',
        { pattern: 'async', path: './src', flags: '-i' },
        undefined,
        undefined,
        {} as any
      );

      expect(result).toBeDefined();
    });
  });

  describe('execute - output format', () => {
    it('should return markdown formatted results', async () => {
      const tool = createGrepTool();
      const { spawn } = await import('node:child_process');
      const mockChild = {
        stdout: { on: vi.fn((event, callback) => {
          if (event === 'data') callback('line1\nline2\n');
        })},
        stderr: { on: vi.fn() },
        on: vi.fn((event, callback) => {
          if (event === 'close') callback(0);
        }),
      };
      vi.mocked(spawn).mockReturnValue(mockChild as any);

      const result = await tool.execute('id', { pattern: 'test' }, undefined, undefined, {} as any);

      expect(result.content[0]?.type).toBe('text');
      expect((result.content[0] as any)?.text).toContain('Search Results');
    });

    it('should include pattern in output', async () => {
      const tool = createGrepTool();
      const { spawn } = await import('node:child_process');
      const mockChild = {
        stdout: { on: vi.fn((_event, callback) => callback('match\n')) },
        stderr: { on: vi.fn() },
        on: vi.fn((event, callback) => {
          if (event === 'close') callback(0);
        }),
      };
      vi.mocked(spawn).mockReturnValue(mockChild as any);

      const result = await tool.execute('id', { pattern: 'async' }, undefined, undefined, {} as any);

      expect((result.content[0] as any)?.text).toContain('async');
    });

    it('should include path in output when provided', async () => {
      const tool = createGrepTool();
      const { spawn } = await import('node:child_process');
      const mockChild = {
        stdout: { on: vi.fn((_event, callback) => callback('match\n')) },
        stderr: { on: vi.fn() },
        on: vi.fn((event, callback) => {
          if (event === 'close') callback(0);
        }),
      };
      vi.mocked(spawn).mockReturnValue(mockChild as any);

      const result = await tool.execute('id', { pattern: 'test', path: './src' }, undefined, undefined, {} as any);

      expect((result.content[0] as any)?.text).toContain('./src');
    });

    it('should include exit code in output', async () => {
      const tool = createGrepTool();
      const { spawn } = await import('node:child_process');
      const mockChild = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((event, callback) => {
          if (event === 'close') callback(42);
        }),
      };
      vi.mocked(spawn).mockReturnValue(mockChild as any);

      const result = await tool.execute('id', { pattern: 'test' }, undefined, undefined, {} as any);

      expect((result.content[0] as any)?.text).toContain('42');
    });
  });

  describe('execute - special characters', () => {
    it('should handle regex patterns', async () => {
      const tool = createGrepTool();
      const { spawn } = await import('node:child_process');
      const mockChild = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((event, callback) => {
          if (event === 'close') callback(0);
        }),
      };
      vi.mocked(spawn).mockReturnValue(mockChild as any);

      const result = await tool.execute('id', { pattern: 'async|await' }, undefined, undefined, {} as any);

      expect(result).toBeDefined();
    });

    it('should handle patterns with spaces', async () => {
      const tool = createGrepTool();
      const { spawn } = await import('node:child_process');
      const mockChild = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((event, callback) => {
          if (event === 'close') callback(0);
        }),
      };
      vi.mocked(spawn).mockReturnValue(mockChild as any);

      const result = await tool.execute('id', { pattern: 'function test' }, undefined, undefined, {} as any);

      expect(result).toBeDefined();
    });

    it('should handle patterns with quotes', async () => {
      const tool = createGrepTool();
      const { spawn } = await import('node:child_process');
      const mockChild = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((event, callback) => {
          if (event === 'close') callback(0);
        }),
      };
      vi.mocked(spawn).mockReturnValue(mockChild as any);

      const result = await tool.execute('id', { pattern: '"quoted string"' }, undefined, undefined, {} as any);

      expect(result).toBeDefined();
    });
  });

  describe('execute - error handling', () => {
    it('should handle spawn errors gracefully', async () => {
      const tool = createGrepTool();
      const { spawn } = await import('node:child_process');
      vi.mocked(spawn).mockReturnValue({
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((event, callback) => {
          if (event === 'error') callback(new Error('Command failed'));
        }),
      } as any);
      const result = await tool.execute('id', { pattern: 'test' }, undefined, undefined, {} as any);

      // Tool should catch errors and return error message
      expect((result.content[0] as any)?.text).toContain('Error');
      expect((result.content[0] as any)?.text).toContain('Neither rg nor grep is available');
    });

    it('should handle grep fallback when rg fails', async () => {
      const tool = createGrepTool();
      const { spawn } = await import('node:child_process');
      let rgCallCount = 0;

      vi.mocked(spawn).mockImplementation((command) => {
        if (command === 'rg') {
          rgCallCount++;
          throw new Error('rg not found');
        } else if (command === 'grep') {
          return {
            stdout: { on: vi.fn() },
            stderr: { on: vi.fn() },
            on: vi.fn((event, callback) => {
              if (event === 'close') callback(0);
            }),
          };
        }
        return {} as any;
      });

      const result = await tool.execute('id', { pattern: 'test' }, undefined, undefined, {} as any);

      expect(rgCallCount).toBe(1);
      expect((result.content[0] as any)?.text).toContain('grep');
    });
  });
});
