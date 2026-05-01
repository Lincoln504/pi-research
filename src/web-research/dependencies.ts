/**
 * Web Research Extension - Dependencies
 *
 * Dependencies are managed by npm via package.json.
 */

import { getDependencyStatus } from './scrapers.ts';
import { getCamoufoxBinaryPath, getBrowserCacheDir } from '../infrastructure/browser-config.ts';
import { existsSync } from 'node:fs';

/**
 * Check all dependencies and return detailed status
 */
export function checkAllDependencies(): {
  playwrightAvailable: boolean;
  browserPath: string;
  browserCacheDir: string;
  browserInstalled: boolean;
} {
  const scrapersStatus = getDependencyStatus();
  const browserPath = getCamoufoxBinaryPath();
  const browserCacheDir = getBrowserCacheDir();
  
  return {
    playwrightAvailable: scrapersStatus.playwrightAvailable,
    browserPath,
    browserCacheDir,
    browserInstalled: existsSync(browserPath),
  };
}
