/**
 * Prompt Loading Utilities
 *
 * Shared helper for loading prompt template files.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../../logger.ts';

// Get the directory where this file is located
const __filename = fileURLToPath(import.meta.url);
const CORE_LLM_DIR = dirname(__filename);

// When running from the source tree: src/core/llm/ → ../../prompts = src/prompts/
// When running from the openclaw bundle (dist/openclaw-entry.js): dist/ → ./prompts = dist/prompts/
// (dist/prompts/ is copied at build time by build:openclaw)
const PROMPT_CANDIDATES = [
  join(CORE_LLM_DIR, '../../prompts'),  // source tree
  join(CORE_LLM_DIR, 'prompts'),        // openclaw bundle (dist/prompts/)
];

/**
 * Load a prompt template from the prompts directory.
 *
 * @param name - Name of the prompt file (without .md extension)
 * @returns The prompt content as a string
 */
export function loadPrompt(name: string): string {
  for (const dir of PROMPT_CANDIDATES) {
    try {
      return readFileSync(join(dir, `${name}.md`), 'utf-8');
    } catch { /* try next candidate */ }
  }
  logger.error(`[prompts] Failed to load prompt: ${name} (searched: ${PROMPT_CANDIDATES.join(', ')})`);
  return '';
}
