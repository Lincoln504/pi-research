/**
 * Web Research Extension - Utilities
 *
 * Helper functions, type guards, and utilities
 */

import { existsSync } from 'node:fs';
import { getCamoufoxBinaryPath } from '../infrastructure/browser/config.ts';

/**
 * Common module checking utility
 */
export function checkModule(name: string): boolean {
  try {
    import.meta.resolve(name);
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
