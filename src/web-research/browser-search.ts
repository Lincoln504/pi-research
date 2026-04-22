/**
 * Web Research Extension - Browser-based Search (DuckDuckGo Lite)
 * 
 * Provides a robust primary search using DuckDuckGo Lite via a managed browser pool.
 * Utilizes the global Browser Manager for hardware-aware concurrency.
 */

import { runBrowserTask } from '../infrastructure/browser-manager.ts';
import { trackContext, untrackContextById, filterRelevantResults } from './utils.ts';
import { logger } from '../logger.ts';
import type { SearXNGResult } from './types.ts';

/**
 * Extracts raw data from the current DuckDuckGo Lite page
 */
async function extractDdgResults(page: any): Promise<SearXNGResult[]> {
  return await page.evaluate(() => {
    const found: any[] = [];
    const doc = (globalThis as any).document;
    const links = Array.from(doc.querySelectorAll('a.result-link'));
    
    links.forEach((link: any) => {
      const row = link.closest('tr');
      const snippet = row?.nextElementSibling?.querySelector('td.result-snippet')?.textContent?.trim() || '';
      const title = link.textContent?.trim() || '';
      let url = link.href;
      
      // Decode destination URL
      try {
        const u = new URL(url);
        const uddg = u.searchParams.get('uddg');
        if (uddg) url = decodeURIComponent(uddg);
      } catch {
        // ignore
      }
      
      if (title && url) {
        found.push({ title, url, content: snippet });
      }
    });
    return found;
  });
}

/**
 * Performs high-fidelity search (2 pages) on DuckDuckGo Lite
 */
async function searchDdgLite(browser: any, query: string, signal?: AbortSignal): Promise<SearXNGResult[]> {
    const context = await browser.newContext();
    const page = await context.newPage();
    const contextId = trackContext(browser, context, page);

    try {
        if (signal?.aborted) return [];

        // Page 1
        await page.goto('https://lite.duckduckgo.com/lite/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.fill('input[name="q"]', query);
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
            page.keyboard.press('Enter')
        ]);

        const resultsP1 = await extractDdgResults(page);
        if (signal?.aborted) return resultsP1;

        // Page 2 (Pagination)
        let resultsP2: SearXNGResult[] = [];
        const nextButton = page.locator('input[value="Next Page >"]');
        if (await nextButton.count() > 0) {
            await Promise.all([
                page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
                nextButton.first().click()
            ]);
            resultsP2 = await extractDdgResults(page);
        }

        const allResults = [...resultsP1, ...resultsP2];
        
        // Map to standard format
        const mapped: SearXNGResult[] = allResults.map(r => ({
            ...r,
            engine: 'browser',
            score: 1.0,
            category: 'general'
        }));

        const relevant = filterRelevantResults(query, mapped);
        logger.log(`[Search] Found ${relevant.length} verified results for: ${query}`);
        
        // ULTRA-TIGHT DELAY: Provide jitter to avoid triggering rate-limits 
        // when the queue immediately launches the next task on this thread
        await new Promise(r => setTimeout(r, 100 + Math.random() * 200));
        
        return relevant;

    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`[Search] Failed for "${query}": ${msg}`);
        return [];
    } finally {
        untrackContextById(contextId);
        await context.close().catch(() => {});
    }
}

/**
 * Orchestrate high-fidelity search across multiple queries.
 */
export async function performSearch(queries: string[], signal?: AbortSignal): Promise<Map<string, SearXNGResult[]>> {
    const resultMap = new Map<string, SearXNGResult[]>();
    
    logger.log(`[Search] Queuing ${queries.length} queries...`);

    const searchPromises = queries.map(async (query) => {
        if (signal?.aborted || !query) return;
        const results = await runBrowserTask((browser) => searchDdgLite(browser, query, signal), 'search');
        resultMap.set(query, results);
    });

    await Promise.all(searchPromises);
    return resultMap;
}
