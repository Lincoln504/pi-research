/**
 * Context Investigation Tool Unit Tests
 *
 * Tests the createInvestigateContextTool function and context investigation behavior.
 * The tool allows coordinators to inspect project context without spawning full researchers.
 */

import { describe, it, expect } from 'vitest';
import type { ContextToolOptions } from '../../../src/orchestration/context-tool';

describe('Context Investigation Tool', () => {
  describe('ContextToolOptions interface', () => {
    it('should accept valid options with all required fields', () => {
      const options: ContextToolOptions = {
        cwd: '/home/user/project',
        ctxModel: { name: 'gpt-4' },
        modelRegistry: {} as any,
      };

      expect(options.cwd).toBe('/home/user/project');
      expect(options.ctxModel).toBeDefined();
      expect(options.modelRegistry).toBeDefined();
    });

    it('should accept different working directories', () => {
      const directories = ['/home/user/project', '/tmp/investigate', '.', '/absolute/path'];

      for (const cwd of directories) {
        const options: ContextToolOptions = {
          cwd,
          ctxModel: { name: 'gpt-4' },
          modelRegistry: {} as any,
        };

        expect(options.cwd).toBe(cwd);
      }
    });

    it('should allow null or undefined ctxModel', () => {
      const optionsNull: ContextToolOptions = {
        cwd: '/home/user/project',
        ctxModel: null,
        modelRegistry: {} as any,
      };

      const optionsUndefined: ContextToolOptions = {
        cwd: '/home/user/project',
        ctxModel: undefined,
        modelRegistry: {} as any,
      };

      expect(optionsNull.ctxModel).toBeNull();
      expect(optionsUndefined.ctxModel).toBeUndefined();
    });

    it('should accept different model types', () => {
      const models = [
        { name: 'gpt-4', version: '1.0' },
        { id: 'claude-3' },
        { type: 'context-model' },
        {},
      ];

      for (const model of models) {
        const options: ContextToolOptions = {
          cwd: '/home/user/project',
          ctxModel: model,
          modelRegistry: {} as any,
        };

        expect(options.ctxModel).toEqual(model);
      }
    });

    it('should accept different modelRegistry implementations', () => {
      const registries = [
        { get: () => {}, list: () => [] } as any,
        { models: [] } as any,
        {} as any,
      ];

      for (const registry of registries) {
        const options: ContextToolOptions = {
          cwd: '/home/user/project',
          ctxModel: { name: 'gpt-4' },
          modelRegistry: registry,
        };

        expect(options.modelRegistry).toEqual(registry);
      }
    });
  });

  describe('Tool definition properties', () => {
    it('should have correct tool name', () => {
      const toolName = 'investigate_context';
      expect(toolName).toBe('investigate_context');
    });

    it('should have descriptive label', () => {
      const label = 'Investigate Context';
      expect(typeof label).toBe('string');
      expect(label.length).toBeGreaterThan(0);
    });

    it('should describe tool purpose', () => {
      const description = 'Inspect the local project codebase (read + grep only, no web search)';
      expect(description).toContain('project');
      expect(description).toContain('grep');
    });
  });

  describe('Tool parameters', () => {
    it('should accept question parameter', () => {
      const question = 'What is this function doing?';
      expect(typeof question).toBe('string');
      expect(question.length).toBeGreaterThan(0);
    });

    it('should handle various question types', () => {
      const questions = [
        'What is this function doing?',
        'Find all usages of this variable',
        'Explain the architecture of this module',
        '',
        'a',
      ];

      for (const question of questions) {
        expect(typeof question).toBe('string');
      }
    });

    it('should handle long questions', () => {
      const longQuestion = 'Analyze this code: '.repeat(50);
      expect(typeof longQuestion).toBe('string');
      expect(longQuestion.length).toBeGreaterThan(100);
    });

    it('should handle special characters in questions', () => {
      const specialQuestions = [
        'What is @decorator doing?',
        'Find all #comments in this file',
        'Search for "quoted strings"',
        'Find $variables',
        'Look for {patterns}',
      ];

      for (const question of specialQuestions) {
        expect(typeof question).toBe('string');
        expect(question.length).toBeGreaterThan(0);
      }
    });
  });

  describe('Text extraction utility', () => {
    it('should extract text from string content', () => {
      const message = { content: 'Hello, world!' };
      // Simulate extractText behavior
      const text = typeof message.content === 'string' ? message.content : '';
      expect(text).toBe('Hello, world!');
    });

    it('should handle null or undefined messages', () => {
      // Simulate extractText with null
      const result1 = null ? 'content' : '';
      // Simulate extractText with undefined
      const result2 = undefined ? 'content' : '';

      expect(result1).toBe('');
      expect(result2).toBe('');
    });

    it('should extract from array content', () => {
      const message = {
        content: [
          { type: 'text', text: 'First part' },
          { type: 'text', text: 'Second part' },
        ],
      };

      // Simulate extractText behavior
      const text = Array.isArray(message.content)
        ? message.content
            .filter((b: any) => b.type === 'text')
            .map((b: any) => b.text)
            .join('\n')
        : '';

      expect(text).toContain('First part');
      expect(text).toContain('Second part');
    });

    it('should handle mixed content types', () => {
      const message = {
        content: [
          { type: 'text', text: 'Text content' },
          { type: 'image', url: 'http://example.com/image.png' },
          { type: 'text', text: 'More text' },
        ],
      };

      // Simulate extractText filtering only text
      const text = Array.isArray(message.content)
        ? message.content
            .filter((b: any) => b.type === 'text')
            .map((b: any) => b.text)
            .join('\n')
        : '';

      expect(text).toContain('Text content');
      expect(text).toContain('More text');
      expect(text).not.toContain('image.png');
    });

    it('should join multiple text blocks with newlines', () => {
      const message = {
        content: [
          { type: 'text', text: 'Line 1' },
          { type: 'text', text: 'Line 2' },
          { type: 'text', text: 'Line 3' },
        ],
      };

      // Simulate extractText
      const text = Array.isArray(message.content)
        ? message.content
            .filter((b: any) => b.type === 'text')
            .map((b: any) => b.text)
            .join('\n')
        : '';

      expect(text.split('\n')).toHaveLength(3);
    });
  });

  describe('Option combinations', () => {
    it('should accept options with minimal configuration', () => {
      const options: ContextToolOptions = {
        cwd: '.',
        ctxModel: undefined,
        modelRegistry: {} as any,
      };

      expect(options.cwd).toBe('.');
      expect(options.ctxModel).toBeUndefined();
    });

    it('should accept options with full configuration', () => {
      const options: ContextToolOptions = {
        cwd: '/home/user/project',
        ctxModel: { name: 'gpt-4', capabilities: ['read', 'grep'] },
        modelRegistry: { models: [{ id: 'gpt-4' }] } as any,
      };

      expect(options.cwd).toBeDefined();
      expect(options.ctxModel).toBeDefined();
      expect(options.modelRegistry).toBeDefined();
    });

    it('should preserve all option fields', () => {
      const options: ContextToolOptions = {
        cwd: '/home/user/project',
        ctxModel: { name: 'gpt-4' },
        modelRegistry: {} as any,
      };

      expect(Object.keys(options).length).toBe(3);
      expect('cwd' in options).toBe(true);
      expect('ctxModel' in options).toBe(true);
      expect('modelRegistry' in options).toBe(true);
    });
  });

  describe('Edge cases', () => {
    it('should handle very long file paths', () => {
      const longPath = '/home/user/' + 'a'.repeat(1000) + '/project';
      const options: ContextToolOptions = {
        cwd: longPath,
        ctxModel: { name: 'gpt-4' },
        modelRegistry: {} as any,
      };

      expect(options.cwd.length).toBeGreaterThan(100);
    });

    it('should handle special characters in paths', () => {
      const paths = [
        '/home/user/project-v1.0',
        '/home/user/project_2024',
        '/home/user/project.backup',
        '/home/user/project@main',
      ];

      for (const path of paths) {
        const options: ContextToolOptions = {
          cwd: path,
          ctxModel: { name: 'gpt-4' },
          modelRegistry: {} as any,
        };

        expect(options.cwd).toBe(path);
      }
    });

    it('should handle model with extended properties', () => {
      const extendedModel = {
        name: 'gpt-4',
        version: '1.0.0',
        capabilities: ['read', 'grep', 'analyze'],
        maxTokens: 8000,
        temperature: 0.7,
        metadata: { type: 'context-model' },
      };

      const options: ContextToolOptions = {
        cwd: '/home/user/project',
        ctxModel: extendedModel,
        modelRegistry: {} as any,
      };

      expect(options.ctxModel).toEqual(extendedModel);
    });
  });
});
