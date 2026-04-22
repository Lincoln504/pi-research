/**
 * Browser Core Logic
 * 
 * Shared logic for search and scraping that can be executed within worker threads.
 */

import { filterRelevantResults } from './utils.ts';
import type { SearXNGResult } from './types.ts';

/**
 * Extracts raw data from the current DuckDuckGo Lite page
 */
export async function extractDdgResults(page: any): Promise<SearXNGResult[]> {
  return await page.evaluate(() => {
    const found: any[] = [];
    const doc = (globalThis as any).document;
    const links = Array.from(doc.querySelectorAll('a.result-link'));
    
    links.forEach((link: any) => {
      const row = link.closest('tr');
      const snippet = row?.nextElementSibling?.querySelector('td.result-snippet')?.textContent?.trim() || '';
      const title = link.textContent?.trim() || '';
      let url = link.href;
      
      try {
        const u = new URL(url);
        const uddg = u.searchParams.get('uddg');
        if (uddg) url = decodeURIComponent(uddg);
      } catch {}
      
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
export async function executeSearchTask(browser: any, query: string): Promise<SearXNGResult[]> {
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
        await page.goto('https://lite.duckduckgo.com/lite/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.fill('input[name="q"]', query);
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
            page.keyboard.press('Enter')
        ]);

        const resultsP1 = await extractDdgResults(page);

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
        const mapped: SearXNGResult[] = allResults.map(r => ({
            ...r,
            engine: 'browser',
            score: 1.0,
            category: 'general'
        }));

        const relevant = filterRelevantResults(query, mapped);
        
        // ULTRA-TIGHT DELAY: Provide jitter to avoid triggering rate-limits 
        // when the worker immediately processes the next query in the burst
        await new Promise(r => setTimeout(r, 100 + Math.random() * 200));

        return relevant;
    } finally {
        await page.close().catch(() => {});
        await context.close().catch(() => {});
    }
}
