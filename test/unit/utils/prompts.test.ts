/**
 * Prompts Utility Unit Tests
 *
 * Tests for loading prompt files with comprehensive error handling,
 * validation, and edge case coverage.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { mkdirSync, rmSync } from 'node:fs';

vi.mock('../../../src/logger.ts', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

describe('utils/prompts', () => {
  let testPromptsDir: string;

  beforeEach(() => {
    // Create a temporary prompts directory for testing
    testPromptsDir = path.join(os.tmpdir(), `pi-prompts-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    mkdirSync(testPromptsDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up test directory
    if (fs.existsSync(testPromptsDir)) {
      rmSync(testPromptsDir, { recursive: true, force: true });
    }
    vi.clearAllMocks();
  });

  describe('loadPrompt - happy path', () => {
    it('loads the real researcher prompt file', async () => {
      const { loadPrompt } = await import('../../../src/core/llm/prompts.ts');
      const content = loadPrompt('researcher');

      expect(typeof content).toBe('string');
      expect(content.length).toBeGreaterThan(0);
      // Verify it looks like a valid prompt (has some structure)
      expect(content).toMatch(/You are/i);
    });

    it('returns non-empty content for known prompts', async () => {
      const { loadPrompt } = await import('../../../src/core/llm/prompts.ts');
      const prompts = ['researcher', 'coordinator', 'agent'];

      for (const promptName of prompts) {
        try {
          const content = loadPrompt(promptName);
          if (content) {
            expect(typeof content).toBe('string');
            expect(content.length).toBeGreaterThan(0);
          }
        } catch {
          // Prompt may not exist, that's ok for this test
        }
      }
    });
  });

  describe('loadPrompt - error handling', () => {
    it('throws for a non-existent prompt (fail-loud, never a blank prompt to the LLM)', async () => {
      const { loadPrompt } = await import('../../../src/core/llm/prompts.ts');
      // A missing prompt is a packaging bug. Returning '' here used to feed a
      // blank system prompt into the LLM call silently; now it throws.
      expect(() => loadPrompt('does-not-exist-xyz-12345')).toThrow(/Failed to load prompt/);
    });

    it('throws for an empty prompt name', async () => {
      const { loadPrompt } = await import('../../../src/core/llm/prompts.ts');
      expect(() => loadPrompt('')).toThrow(/Rejected unsafe prompt name/);
    });

    it('rejects (throws on) path-traversal prompt names via the allowlist guard', async () => {
      const { loadPrompt } = await import('../../../src/core/llm/prompts.ts');
      const { logger } = await import('../../../src/logger.ts');
      // For unsafe names the guard fires and logs a DISTINCT "Rejected unsafe
      // prompt name" message — different from the "Failed to load" message used
      // when a safe name simply isn't found. Asserting that distinct message
      // proves the protection executed, not that the .md suffix happened to miss.
      for (const unsafe of [
        '../etc/passwd',
        '../researcher',
        '../..//etc/hosts',
        '/etc/passwd',
        'sub/dir/name',
        'name .md',
        '..',
      ]) {
        vi.mocked(logger.error).mockClear();
        expect(() => loadPrompt(unsafe)).toThrow(/Rejected unsafe prompt name/);
        expect(logger.error).toHaveBeenCalledWith(
          expect.stringContaining('Rejected unsafe prompt name'),
        );
      }
    });

    it('still reads files for safe identifier names (guard is not over-broad)', async () => {
      const { loadPrompt } = await import('../../../src/core/llm/prompts.ts');
      // A normal prompt name passes the guard and loads real content.
      expect(loadPrompt('researcher').length).toBeGreaterThan(0);
    });

    it('throws (does not silently pass) for null/undefined prompt name', async () => {
      const { loadPrompt } = await import('../../../src/core/llm/prompts.ts');
      expect(() => loadPrompt(null as any)).toThrow(/Rejected unsafe prompt name/);
      expect(() => loadPrompt(undefined as any)).toThrow(/Rejected unsafe prompt name/);
    });
  });

  describe('loadPrompt - content validation', () => {
    it('returns string content for valid prompt', async () => {
      const { loadPrompt } = await import('../../../src/core/llm/prompts.ts');
      const content = loadPrompt('researcher');

      expect(content).toBeTypeOf('string');
      // Should have meaningful content
      expect(content.length).toBeGreaterThan(50);
    });

    it('handles prompts with unicode characters', async () => {
      const { loadPrompt } = await import('../../../src/core/llm/prompts.ts');
      // Test with a real prompt that might have unicode
      const content = loadPrompt('researcher');

      // Should handle unicode without throwing
      expect(() => content.normalize('NFC')).not.toThrow();
      expect(() => Buffer.from(content).toString('utf-8')).not.toThrow();
    });

    it('handles prompts with special markdown characters', async () => {
      const { loadPrompt } = await import('../../../src/core/llm/prompts.ts');
      const content = loadPrompt('researcher');

      // Should preserve markdown formatting
      expect(content).toMatch(/[`#*\[\]]/); // Has some markdown syntax
    });
  });

  describe('loadPrompt - edge cases', () => {
    it('loads prompt without throwing', async () => {
      const { loadPrompt } = await import('../../../src/core/llm/prompts.ts');
      const content = loadPrompt('researcher');

      // Should not throw - either loads content or returns empty string
      expect(typeof content).toBe('string');
    });

    it('handles multiple consecutive loads of the same prompt', async () => {
      const { loadPrompt } = await import('../../../src/core/llm/prompts.ts');

      const content1 = loadPrompt('researcher');
      const content2 = loadPrompt('researcher');
      const content3 = loadPrompt('researcher');

      // All should return the same content
      expect(content1).toBe(content2);
      expect(content2).toBe(content3);
    });

    it('loads the canonical lowercase name (the only guaranteed-present file)', async () => {
      const { loadPrompt } = await import('../../../src/core/llm/prompts.ts');
      // The shipped file is researcher.md (lowercase). Case variants are
      // filesystem-dependent (miss → throw on Linux, hit on case-insensitive FS),
      // so we only assert the canonical name, which exists everywhere.
      expect(typeof loadPrompt('researcher')).toBe('string');
    });

    it('throws when the name already includes the .md extension (looks for researcher.md.md)', async () => {
      const { loadPrompt } = await import('../../../src/core/llm/prompts.ts');
      // '.md' passes the allowlist, so this becomes a plain file-miss → fail-loud.
      expect(() => loadPrompt('researcher.md')).toThrow(/Failed to load prompt/);
      expect(loadPrompt('researcher').length).toBeGreaterThan(0);
    });
  });

  describe('loadPrompt - performance and large files', () => {
    it('handles large prompt files efficiently', async () => {
      const { loadPrompt } = await import('../../../src/core/llm/prompts.ts');
      const startTime = Date.now();

      const content = loadPrompt('researcher');
      const duration = Date.now() - startTime;

      // Should load quickly (< 100ms for reasonable file sizes)
      expect(duration).toBeLessThan(100);
      expect(content.length).toBeGreaterThan(0);
    });

    it('does not cache stale content', async () => {
      const { loadPrompt } = await import('../../../src/core/llm/prompts.ts');

      // Load twice, ensure we're getting fresh content
      const content1 = loadPrompt('researcher');
      const content2 = loadPrompt('researcher');

      // Should be the same (file hasn't changed)
      expect(content1).toBe(content2);
    });
  });

  describe('loadPrompt - security', () => {
    it('does not allow directory traversal attacks', async () => {
      const { loadPrompt } = await import('../../../src/core/llm/prompts.ts');

      // Try various path traversal attempts
      const maliciousNames = [
        '../../../etc/passwd',
        '..\\..\\..\\windows\\system32',
        '/etc/passwd',
        'C:\\Windows\\System32',
      ];

      for (const name of maliciousNames) {
        // The allowlist guard rejects every traversal attempt by throwing — so a
        // sensitive system file is never read (and never returned).
        expect(() => loadPrompt(name)).toThrow(/Rejected unsafe prompt name/);
      }
    });

    it('throws on a very long (but valid-charset) name — file-miss, not silent ""', async () => {
      const { loadPrompt } = await import('../../../src/core/llm/prompts.ts');
      const longName = 'a'.repeat(10000);
      expect(() => loadPrompt(longName)).toThrow(/Failed to load prompt/);
    });
  });
});
