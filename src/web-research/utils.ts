/**
 * Web Research Extension - Utilities
 *
 * Helper functions, type guards, and utilities
 */

import { createRequire } from 'module';
import { existsSync } from 'node:fs';
import { getCamoufoxBinaryPath } from '../infrastructure/browser-config.ts';

const require = createRequire(import.meta.url);

/**
 * Common module checking utility
 */
export function checkModule(name: string): boolean {
  try {
    require.resolve(name);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if browser binaries are installed
 */
export function checkBrowserBinaries(): boolean {
  return existsSync(getCamoufoxBinaryPath());
}
