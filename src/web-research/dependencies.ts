/**
 * Web Research Extension - Dependencies
 *
 * Dependencies are managed by npm via package.json.
 * No custom install/uninstall commands needed.
 */

import { getDependencyStatus } from './scrapers.ts';

/**
 * Check all dependencies and return detailed status
 */
export function checkAllDependencies(): {
  playwrightAvailable: boolean;
  } {
  const scrapersStatus = getDependencyStatus();
  return {
    playwrightAvailable: scrapersStatus.playwrightAvailable,
  };
}
