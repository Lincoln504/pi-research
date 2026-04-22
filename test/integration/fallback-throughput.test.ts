
import { describe, it, expect } from 'vitest';
import { getCamoufoxBrowser } from '../../src/infrastructure/camoufox-lifecycle.ts';
import { filterRelevantResults } from '../../src/web-research/utils.ts';

/**
 * Advanced Throughput Validation
 * 
 * Verifies that the Camoufox + DDG Lite strategy can handle 
 * parallel high-fidelity searches with pagination.
 */
describe('DuckDuckGo Lite Throughput Integration', () => {
  
  async function performParallelSearch(query: string) {
    const browser = await getCamoufoxBrowser();
    const context = await browser.newContext();
    const page = await context.newPage();
    
    // Performance: Block non-essential assets
    await page.route('**/*', (route: any) => {
        const type = route.request().resourceType();
        if (['image', 'stylesheet', 'font', 'media'].includes(type)) {
            route.abort();
        } else {
            route.continue();
        }
    });

    try {
      console.log(`[Throughput Test] Searching: ${query}`);
      // Page 1
      await page.goto('https://lite.duckduckgo.com/lite/', { waitUntil: 'domcontentloaded' });
      await page.fill('input[name="q"]', query);
      await Promise.all([
          page.waitForSelector('a.result-link', { timeout: 20000 }),
          page.keyboard.press('Enter')
      ]);

      const results1 = await page.evaluate(() => {
          return Array.from(document.querySelectorAll('a.result-link')).map(link => ({
              title: link.textContent?.trim() || '',
              content: link.closest('tr')?.nextElementSibling?.querySelector('td.result-snippet')?.textContent?.trim() || '',
              url: (link as HTMLAnchorElement).href
          }));
      });
      console.log(`[Throughput Test] Page 1 done for "${query}" (${results1.length} items)`);

      // Page 2 (Pagination)
      let results2: any[] = [];
      const nextButton = page.locator('input[value="Next Page >"]');
      if (await nextButton.count() > 0) {
          await Promise.all([
              page.waitForSelector('a.result-link', { timeout: 20000 }),
              nextButton.first().click()
          ]);
          results2 = await page.evaluate(() => {
              return Array.from(document.querySelectorAll('a.result-link')).map(link => ({
                  title: link.textContent?.trim() || '',
                  content: link.closest('tr')?.nextElementSibling?.querySelector('td.result-snippet')?.textContent?.trim() || '',
                  url: (link as HTMLAnchorElement).href
              }));
          });
          console.log(`[Throughput Test] Page 2 done for "${query}" (${results2.length} items)`);
      }

      const allResults = [...results1, ...results2];
      const relevant = filterRelevantResults(query, allResults);
      
      return {
        total: allResults.length,
        relevant: relevant.length,
        success: relevant.length > 0
      };
    } finally {
      await context.close();
    }
  }

  it('should sustain sequential high-fidelity searches with 2-page pagination', async () => {
    const queries = [
      "latest advances in fusion energy 2026",
      "rust programming language concurrency patterns"
    ];

    const results = [];
    for (const q of queries) {
      results.push(await performParallelSearch(q));
    }
    
    results.forEach((res, i) => {
      console.log(`Query "${queries[i]}": ${res.total} total, ${res.relevant} relevant`);
      expect(res.success).toBe(true);
      expect(res.total).toBeGreaterThanOrEqual(20);
    });
  }, 120000); // 2 minute timeout
});
