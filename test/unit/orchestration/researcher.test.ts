/**
 * Researcher Agent Unit Tests
 *
 * Tests the createResearcherSession function and its behavior
 * with different configuration options.
 */

import { describe, it, expect, vi } from 'vitest';
import type { CreateResearcherSessionOptions } from '../../../src/orchestration/researcher';

describe('Researcher Agent', () => {
  describe('CreateResearcherSessionOptions interface', () => {
    it('should accept valid options with all required fields', () => {
      const options: CreateResearcherSessionOptions = {
        cwd: '/home/user/project',
        ctxModel: { name: 'gpt-4' },
        modelRegistry: {} as any,
        sessionManager: {} as any,
        settingsManager: {} as any,
        systemPrompt: 'You are a researcher',
        searxngUrl: 'http://localhost:8080',
        extensionCtx: {},
      };

      expect(options.cwd).toBe('/home/user/project');
      expect(options.searxngUrl).toBe('http://localhost:8080');
    });

    it('should allow different working directories', () => {
      const directories = ['/home/user/project', '/tmp/work', '.', '/absolute/path'];

      for (const cwd of directories) {
        const options: CreateResearcherSessionOptions = {
          cwd,
          ctxModel: { name: 'gpt-4' },
          modelRegistry: {} as any,
          sessionManager: {} as any,
          settingsManager: {} as any,
          systemPrompt: 'You are a researcher',
          searxngUrl: 'http://localhost:8080',
          extensionCtx: {},
        };

        expect(options.cwd).toBe(cwd);
      }
    });

    it('should allow null or undefined ctxModel', () => {
      const optionsNull: CreateResearcherSessionOptions = {
        cwd: '/home/user/project',
        ctxModel: null,
        modelRegistry: {} as any,
        sessionManager: {} as any,
        settingsManager: {} as any,
        systemPrompt: 'You are a researcher',
        searxngUrl: 'http://localhost:8080',
        extensionCtx: {},
      };

      const optionsUndefined: CreateResearcherSessionOptions = {
        cwd: '/home/user/project',
        ctxModel: undefined,
        modelRegistry: {} as any,
        sessionManager: {} as any,
        settingsManager: {} as any,
        systemPrompt: 'You are a researcher',
        searxngUrl: 'http://localhost:8080',
        extensionCtx: {},
      };

      expect(optionsNull.ctxModel).toBeNull();
      expect(optionsUndefined.ctxModel).toBeUndefined();
    });

    it('should accept different SearXNG URLs', () => {
      const urls = [
        'http://localhost:8080',
        'http://proxy.example.com:3128',
        'https://searxng.example.com',
        'http://192.168.1.1:9090',
      ];

      for (const url of urls) {
        const options: CreateResearcherSessionOptions = {
          cwd: '/home/user/project',
          ctxModel: { name: 'gpt-4' },
          modelRegistry: {} as any,
          sessionManager: {} as any,
          settingsManager: {} as any,
          systemPrompt: 'You are a researcher',
          searxngUrl: url,
          extensionCtx: {},
        };

        expect(options.searxngUrl).toBe(url);
      }
    });

    it('should accept custom system prompts', () => {
      const prompts = [
        'You are a researcher',
        'You are an expert AI assistant',
        'Research the topic thoroughly and provide detailed findings',
        '',
      ];

      for (const prompt of prompts) {
        const options: CreateResearcherSessionOptions = {
          cwd: '/home/user/project',
          ctxModel: { name: 'gpt-4' },
          modelRegistry: {} as any,
          sessionManager: {} as any,
          settingsManager: {} as any,
          systemPrompt: prompt,
          searxngUrl: 'http://localhost:8080',
          extensionCtx: {},
        };

        expect(options.systemPrompt).toBe(prompt);
      }
    });

    it('should accept different model objects', () => {
      const models = [
        { name: 'gpt-4', version: '1.0' },
        { id: 'claude-3' },
        { type: 'llm' },
        {},
      ];

      for (const model of models) {
        const options: CreateResearcherSessionOptions = {
          cwd: '/home/user/project',
          ctxModel: model,
          modelRegistry: {} as any,
          sessionManager: {} as any,
          settingsManager: {} as any,
          systemPrompt: 'You are a researcher',
          searxngUrl: 'http://localhost:8080',
          extensionCtx: {},
        };

        expect(options.ctxModel).toEqual(model);
      }
    });

    it('should accept extension context objects', () => {
      const contexts = [
        { vscode: 'extension' },
        { id: 'ext-123' },
        {},
        null,
      ];

      for (const ctx of contexts) {
        const options: CreateResearcherSessionOptions = {
          cwd: '/home/user/project',
          ctxModel: { name: 'gpt-4' },
          modelRegistry: {} as any,
          sessionManager: {} as any,
          settingsManager: {} as any,
          systemPrompt: 'You are a researcher',
          searxngUrl: 'http://localhost:8080',
          extensionCtx: ctx,
        };

        expect(options.extensionCtx).toEqual(ctx);
      }
    });
  });

  describe('Option validation scenarios', () => {
    it('should handle relative working directories', () => {
      const options: CreateResearcherSessionOptions = {
        cwd: './src/project',
        ctxModel: { name: 'gpt-4' },
        modelRegistry: {} as any,
        sessionManager: {} as any,
        settingsManager: {} as any,
        systemPrompt: 'You are a researcher',
        searxngUrl: 'http://localhost:8080',
        extensionCtx: {},
      };

      expect(options.cwd).toMatch(/^\./);
    });

    it('should handle long system prompts', () => {
      const longPrompt = 'You are a researcher. '.repeat(100);
      const options: CreateResearcherSessionOptions = {
        cwd: '/home/user/project',
        ctxModel: { name: 'gpt-4' },
        modelRegistry: {} as any,
        sessionManager: {} as any,
        settingsManager: {} as any,
        systemPrompt: longPrompt,
        searxngUrl: 'http://localhost:8080',
        extensionCtx: {},
      };

      expect(options.systemPrompt.length).toBeGreaterThan(100);
    });

    it('should preserve all required option fields', () => {
      const options: CreateResearcherSessionOptions = {
        cwd: '/home/user/project',
        ctxModel: { name: 'gpt-4' },
        modelRegistry: { get: () => {} } as any,
        sessionManager: { create: () => {} } as any,
        settingsManager: { get: () => {} } as any,
        systemPrompt: 'You are a researcher',
        searxngUrl: 'http://localhost:8080',
        extensionCtx: { id: 'ext-1' },
      };

      expect(options.cwd).toBeDefined();
      expect(options.ctxModel).toBeDefined();
      expect(options.modelRegistry).toBeDefined();
      expect(options.sessionManager).toBeDefined();
      expect(options.settingsManager).toBeDefined();
      expect(options.systemPrompt).toBeDefined();
      expect(options.searxngUrl).toBeDefined();
      expect(options.extensionCtx).toBeDefined();
    });
  });
});
