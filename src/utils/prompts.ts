/**
 * Prompt Loading Utilities
 *
 * Shared helper for loading prompt template files.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../logger.ts';

// Get the directory where this file is located
const __filename = fileURLToPath(import.meta.url);
const UTILS_DIR = dirname(__filename);

/**
 * Load a prompt template from the prompts directory.
 *
 * @param name - Name of the prompt file (without .md extension)
 * @param relativePath - Relative path from the calling file to the prompts directory
 * @returns The prompt content as a string
 */
export function loadPrompt(name: string, relativePath: string = '..'): string {
  try {
    const promptPath = join(UTILS_DIR, relativePath, 'prompts', `${name}.md`);
    return readFileSync(promptPath, 'utf-8');
  } catch (err) {
    logger.error(`[prompts] Failed to load prompt: ${name}`, err);
    return '';
  }
}
