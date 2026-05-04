/**
 * Research Export Utility
 *
 * Resolves a smart output directory for research reports:
 *
 *   1. cwd is the user's home directory or a system directory → os.tmpdir()
 *   2. cwd has a recognised first-level subdirectory            → that subdir
 *      (research, docs, doc, ref, references, notes)
 *   3. Otherwise                                               → cwd
 *
 * Cross-platform: works on Linux, macOS, and Windows.
 * Subdir detection uses case-insensitive readdir matching so it works correctly
 * on case-insensitive filesystems (macOS APFS, Windows NTFS).
 */

import { promises as fs } from 'node:fs';
import { homedir, tmpdir, platform } from 'node:os';
import { join, resolve, normalize, sep } from 'node:path';
import { logger } from '../logger.ts';
import { MAX_FILENAME_QUERY_LENGTH, MAX_EXPORT_RETRIES } from '../constants.ts';

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
const DIGITS = '0123456789';

// Subdirectory names to probe, in priority order. Matched case-insensitively.
const PREFERRED_SUBDIRS = [
  'research',
  'docs',
  'doc',
  'ref',
  'references',
  'notes',
];

// Unix/macOS paths that are never appropriate output destinations.
const UNIX_SYSTEM_PREFIXES = [
  '/',
  '/bin', '/sbin', '/usr', '/lib', '/lib32', '/lib64',
  '/etc', '/var', '/opt', '/root', '/proc', '/sys',
  '/dev', '/run', '/boot', '/srv',
  '/Applications', '/Library', '/System', // macOS
];

// Windows paths (lowercased for comparison) that are never appropriate.
const WIN_SYSTEM_PREFIXES_LC = [
  'c:\\windows',
  'c:\\program files',
  'c:\\program files (x86)',
  'c:\\programdata',
  'c:\\recovery',
];

/**
 * Returns true when `dir` is the user's home directory or a system directory
 * where writing research files would be unexpected or inappropriate.
 */
function isSafeToWriteDirectly(dir: string): boolean {
  const normalized = normalize(resolve(dir));

  // Reject the home directory itself
  const home = normalize(resolve(homedir()));
  if (normalized === home) return false;

  if (platform() === 'win32') {
    // Reject bare drive roots (e.g. C:\) and known system paths
    if (/^[a-zA-Z]:\\?$/.test(normalized)) return false;
    const lc = normalized.toLowerCase();
    for (const prefix of WIN_SYSTEM_PREFIXES_LC) {
      if (lc === prefix || lc.startsWith(prefix + sep) || lc.startsWith(prefix + '/')) {
        return false;
      }
    }
  } else {
    // Unix / macOS
    for (const prefix of UNIX_SYSTEM_PREFIXES) {
      // Exact match or prefix + separator
      if (normalized === prefix || normalized.startsWith(prefix + sep)) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Probe `cwd` for a recognised research-output subdirectory.
 * Uses readdir + case-insensitive comparison so it works on any filesystem.
 * Returns the first match in PREFERRED_SUBDIRS priority order, or null.
 */
async function findPreferredSubdir(cwd: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(cwd);
  } catch {
    return null;
  }

  for (const target of PREFERRED_SUBDIRS) {
    const match = entries.find(e => e.toLowerCase() === target);
    if (match === undefined) continue;
    const candidate = join(cwd, match);
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) return candidate;
    } catch {
      // Not a directory or not accessible — keep looking
    }
  }
  return null;
}

/**
 * Resolve the directory where the report should be saved.
 */
async function resolveExportDir(cwd: string): Promise<string> {
  if (!isSafeToWriteDirectly(cwd)) {
    logger.log(`[export] cwd "${cwd}" is home/system — using tmpdir`);
    return tmpdir();
  }

  const subdir = await findPreferredSubdir(cwd);
  if (subdir !== null) {
    logger.log(`[export] Using preferred subdir: ${subdir}`);
    return subdir;
  }

  return cwd;
}

/**
 * Sanitize query for use in a filename.
 */
function sanitizeQuery(query: string): string {
  return query
    .toLowerCase()
    .trim()
    .slice(0, MAX_FILENAME_QUERY_LENGTH)
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Generate a random hash for collision avoidance.
 * Format: letter + number (e.g., a3, b7, x9)
 */
function generateHash(): string {
  const letter = LETTERS[Math.floor(Math.random() * LETTERS.length)]!;
  const digit = DIGITS[Math.floor(Math.random() * DIGITS.length)]!;
  return letter + digit;
}

/**
 * Export a research report to the resolved output directory.
 *
 * @param query  - The research query (used to derive the filename)
 * @param result - The report content
 * @param _mode  - 'quick' | 'deep' (reserved for future use)
 * @param cwd    - The working directory of the pi session
 * @returns The saved file path, or null on failure
 */
export async function exportResearchReport(
  query: string,
  result: string,
  _mode: 'quick' | 'deep',
  cwd?: string,
): Promise<string | null> {
  const sanitizedQuery = sanitizeQuery(query);
  const baseFilename = `pi-research-${sanitizedQuery}`;
  const targetDir = await resolveExportDir(cwd ?? tmpdir());

  for (let attempt = 0; attempt < MAX_EXPORT_RETRIES; attempt++) {
    const hash = generateHash();
    const filename = `${baseFilename}-${hash}.md`;
    const filepath = join(targetDir, filename);

    try {
      await fs.writeFile(filepath, result, { flag: 'wx' });
      logger.log(`[export] Research report saved to: ${filepath}`);
      return filepath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      logger.error(`[export] Failed to save research report:`, error);
      return null;
    }
  }

  logger.error(`[export] Failed to save research report after ${MAX_EXPORT_RETRIES} attempts (hash collision)`);
  return null;
}

/**
 * Append the saved-path footer to a research result string.
 */
export function appendExportMessage(result: string, filepath: string): string {
  return result + `\n\n---\n\nResearch report saved to: ${filepath}`;
}
