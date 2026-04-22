/**
 * Web Research Extension - Fallback Search (DuckDuckGo Lite)
 * 
 * Provides a robust stealth-browser based search fallback using DuckDuckGo Lite.
 */

import { getCamoufoxBrowser } from '../infrastructure/camoufox-lifecycle.ts';
import { trackContext, untrackContextById, filterRelevantResults } from './utils.ts';
import { logger } from '../logger.ts';
import type { SearXNGResult } from './types.ts';

/**
 * Perform a single search on DuckDuckGo Lite via Camoufox
 */
async function searchDdgLite(query: string, signal?: AbortSignal): Promise<SearXNGResult[]> {
  if (signal?.aborted) return [];

  const browser = await getCamoufoxBrowser();
  if (signal?.aborted) return [];

  let context: any = null;
  let page: any = null;
  let contextId: string | null = null;

  try {
    context = await browser.newContext();
    page = await context.newPage();
    contextId = trackContext(browser, context, page);

    const baseUrl = 'https://lite.duckduckgo.com/lite/';
    logger.log(`[Fallback Search] Navigating to DDG Lite: ${query}`);

    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    if (signal?.aborted) return [];

    await page.fill('input[name="q"]', query);
    
    // Trigger search
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
      page.click('input.submit[value="Search"]')
    ]);

    if (signal?.aborted) return [];

    const title = await page.title();
    if (title.includes('Security Check') || title.includes('CAPTCHA')) {
      logger.error(`[Fallback Search] BLOCKED by DDG for query: "${query}"`);
      return [];
    }

    // Extract results
    const results = await page.evaluate(() => {
      const found: Array<{title: string, url: string, content: string}> = [];
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

    const mapped: SearXNGResult[] = (results as any[]).map(r => ({
      ...r,
      engine: 'ddg-lite-stealth',
      score: 1.0,
      category: 'general'
    }));

    // Apply relevance guard to fallback results as well
    const relevantResults = filterRelevantResults(query, mapped);
    if (mapped.length > 0 && relevantResults.length === 0) {
      logger.warn(`[Fallback Search] Junk results detected from DDG for "${query}".`);
      return [];
    }

    logger.log(`[Fallback Search] Successfully found ${relevantResults.length} results for: ${query}`);
    return relevantResults;

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(`[Fallback Search] Error searching "${query}": ${msg}`);
    return [];
  } finally {
    if (contextId) untrackContextById(contextId);
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
  }
}

/**
 * Orchestrate batch fallback search with delays to avoid detection
 */
export async function performFallbackSearch(queries: string[], signal?: AbortSignal): Promise<Map<string, SearXNGResult[]>> {
  const resultMap = new Map<string, SearXNGResult[]>();
  
  for (let i = 0; i < queries.length; i++) {
    const query = queries[i];
    if (signal?.aborted || !query) break;
    
    const results = await searchDdgLite(query, signal);
    resultMap.set(query, results);
    
    // 5-second delay between queries as verified in experiments
    if (i < queries.length - 1 && !signal?.aborted) {
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  
  return resultMap;
}
