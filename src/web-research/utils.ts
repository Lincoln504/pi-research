/**
 * Web Research Extension - Utilities
 *
 * Helper functions, type guards, and utilities
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

/**
 * Common module checking utility.
 *
 * Resolves via CJS `require.resolve` from a file anchor. `import.meta.resolve`
 * cannot be used: pi loads this extension through a transform pipeline (jiti /
 * esbuild CJS) where `import.meta` compiles to an empty object, so
 * `import.meta.resolve` is undefined and calling it throws — the old
 * implementation silently reported an installed module as missing, which
 * disabled the browser scrape path (`playwrightAvailable` in web-scraper.ts).
 * Try each available anchor in turn: the ESM `import.meta.url` (valid under
 * jiti and plain Node ESM) and the CJS `__filename` (valid in CJS-compiled
 * output, where `import.meta.url` is undefined).
 */
export function checkModule(name: string): boolean {
  const anchors: string[] = [];
  if (typeof import.meta.url === 'string') anchors.push(import.meta.url);
  if (typeof __filename !== 'undefined') anchors.push(pathToFileURL(__filename).href);
  for (const anchor of anchors) {
    try {
      createRequire(anchor).resolve(`${name}/package.json`);
      return true;
    } catch {
      // try the next anchor
    }
  }
  return false;
}
