/**
 * Web Research Extension - Fallback Search (DuckDuckGo Lite)
 * 
 * Provides a robust stealth-browser based search fallback using DuckDuckGo Lite.
 * Implements advanced 2-page pagination and high-fidelity extraction.
 */

import { getCamoufoxBrowser, getRecommendedConcurrency } from '../infrastructure/camoufox-lifecycle.ts';
import { trackContext, untrackContextById, filterRelevantResults } from './utils.ts';
import { logger } from '../logger.ts';
import type { SearXNGResult } from './types.ts';

/**
 * Extracts results from the current DuckDuckGo Lite page
 */
async function extractDdgResults(page: any): Promise<SearXNGResult[]> {
  return await page.evaluate(() => {
    const found: any[] = [];
    const doc = (globalThis as any).document;
    const links = Array.from(doc.querySelectorAll('a.result-link'));
    
    links.forEach((link: any) => {
      const title = link.textContent?.trim() || '';
      let rawUrl = link.href;
      
      // Decode uddg proxy URL if present
      try {
        const urlObj = new URL(rawUrl);
        const uddg = urlObj.searchParams.get('uddg');
        if (uddg) rawUrl = decodeURIComponent(uddg);
      } catch (e) {}
      
      let snippet = '';
      const row = link.closest('tr');
      if (row && row.nextElementSibling) {
        const snippetCell = row.nextElementSibling.querySelector('td.result-snippet');
        snippet = snippetCell?.textContent?.trim() || '';
      }
      
      if (title && rawUrl) {
        found.push({ title, url: rawUrl, content: snippet });
      }
    });
    return found;
  });
}

/**
 * Perform an advanced 2-page search on DuckDuckGo Lite
 */
async function searchDdgLite(query: string, signal?: AbortSignal): Promise<SearXNGResult[]> {
  const browser = await getCamoufoxBrowser();
  const context = await browser.newContext();
  const page = await context.newPage();
  
  const contextId = trackContext(browser, context, page);

  try {
    // Optimization: Block non-essential assets for speed and stealth
    await page.route('**/*', (route: any) => {
      const type = route.request().resourceType();
      if (['image', 'stylesheet', 'font', 'media'].includes(type)) {
        route.abort();
      } else {
        route.continue();
      }
    });

    if (signal?.aborted) return [];

    // STEP 1: Page 1
    await page.goto('https://lite.duckduckgo.com/lite/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.fill('input[name="q"]', query);
    
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
      page.click('input.submit[value="Search"]')
    ]);

    const resultsP1 = await extractDdgResults(page);

    if (signal?.aborted) return resultsP1;

    // STEP 2: Page 2 (Pagination)
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
    
    // Map to SearXNG format
    const mapped: SearXNGResult[] = allResults.map(r => ({
      ...r,
      engine: 'ddg-lite-stealth',
      score: 1.0,
      category: 'general'
    }));

    // Apply shared relevance guard
    const relevantResults = filterRelevantResults(query, mapped);
    
    if (mapped.length > 0 && relevantResults.length === 0) {
      logger.warn(`[Fallback Search] Junk results detected from DDG for "${query}".`);
      return [];
    }

    logger.log(`[Fallback Search] Successfully found ${relevantResults.length} high-fidelity results for: ${query}`);
    return relevantResults;

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(`[Fallback Search] Error searching "${query}": ${msg}`);
    return [];
  } finally {
    untrackContextById(contextId);
    await context.close().catch(() => {});
  }
}

/**
 * Orchestrate batch fallback search with dynamic hardware-based concurrency
 */
export async function performFallbackSearch(queries: string[], signal?: AbortSignal): Promise<Map<string, SearXNGResult[]>> {
  const resultMap = new Map<string, SearXNGResult[]>();
  
  // DYNAMIC CONCURRENCY: Scale based on available CPU threads (CPUs - 3)
  const CONCURRENCY = getRecommendedConcurrency();
  
  logger.log(`[Fallback Search] Starting batch of ${queries.length} queries with concurrency ${CONCURRENCY}`);
  
  for (let i = 0; i < queries.length; i += CONCURRENCY) {
    const batch = queries.slice(i, i + CONCURRENCY);
    const promises = batch.map(async (query) => {
      if (signal?.aborted || !query) return;
      const results = await searchDdgLite(query, signal);
      resultMap.set(query, results);
    });
    
    await Promise.all(promises);

    // Optimized 1.5-second jitter delay between batches
    if (i + CONCURRENCY < queries.length && !signal?.aborted) {
      await new Promise(r => setTimeout(r, 1500 + Math.random() * 500));
    }
  }
  
  return resultMap;
}
