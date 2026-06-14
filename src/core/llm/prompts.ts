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
const PROMPTS_DIR = join(CORE_LLM_DIR, '../../prompts');

/**
 * Load a prompt template from the prompts directory.
 *
 * @param name - Name of the prompt file (without .md extension)
 * @returns The prompt content as a string
 */
export function loadPrompt(name: string): string {
  try {
    const promptPath = join(PROMPTS_DIR, `${name}.md`);
    return readFileSync(promptPath, 'utf-8');
  } catch (err) {
    logger.error(`[prompts] Failed to load prompt: ${name}`, err);
    return '';
  }
}
