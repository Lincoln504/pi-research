/**
 * Poolifier Thread Worker
 *
 * Executes search tasks in worker threads.
 *
 * PRODUCTION CONFIGURATION:
 * - Browser Mode: WARM (reuses browser instances)
 * - Performance: 3x faster than fresh browser (0.300 vs 0.094 q/s)
 */

import { ThreadWorker } from 'poolifier';
import * as os from 'node:os';

// Set worker priority to reduce system impact
try {
    os.setPriority(process.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
} catch (e) {}

// Warm browser: Reuse browser instance across queries
let browser = null;
let context = null;

async function initBrowser() {
    if (!browser || !context) {
        const { Camoufox } = require('camoufox-js');
        browser = await Camoufox({ headless: true, humanize: true });
        context = await browser.newContext();
    }
}

async function checkBlocked(page) {
    try {
        const blocked = await page.evaluate(() => {
            const text = document.body.textContent.toLowerCase();
            const blockedKeywords = [
                'access denied',
                'too many requests',
                'rate limit',
                'blocked',
                'captcha',
                'please wait',
                'human verification',
                'security check',
                'temporarily blocked',
                'ip blocked'
            ];
            return blockedKeywords.some(kw => text.includes(kw));
        });
        return blocked;
    } catch (e) {
        return false;
    }
}

async function extractResults(page) {
    return await page.evaluate(() => {
        const found = [];
        const links = Array.from(document.querySelectorAll('a.result-link'));
        links.forEach(link => {
            const row = link.closest('tr');
            const snippet = row?.nextElementSibling?.querySelector('td.result-snippet')?.textContent?.trim() || '';
            const title = link.textContent?.trim() || '';
            let url = link.href;
            try {
                const u = new URL(url);
                const uddg = u.searchParams.get('uddg');
                if (uddg) url = decodeURIComponent(uddg);
            } catch {}
            if (title && url) found.push({ title, url, content: snippet });
        });
        return found;
    });
}

async function executeSearchTask(browser, context, query) {
    const page = await context.newPage();

    try {
        await page.goto('https://lite.duckduckgo.com/lite/', { 
            waitUntil: 'domcontentloaded', 
            timeout: 30000 
        });
        
        await page.fill('input[name="q"]', query);
        
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
            page.keyboard.press('Enter')
        ]);

        // Check if blocked
        const blocked = await checkBlocked(page);
        if (blocked) {
            await page.close();
            return { results: [], blocked: true };
        }

        // Extract page 1 results
        const p1Results = await extractResults(page);
        
        // Try to get page 2 results
        let p2Results = [];
        try {
            const nextButton = page.locator('input[value="Next Page >"]');
            if (await nextButton.count() > 0) {
                await Promise.all([
                    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
                    nextButton.first().click()
                ]);
                p2Results = await extractResults(page);
            }
        } catch (e) {
            // Ignore errors on page 2
        }

        await page.close();

        return {
            results: [...p1Results, ...p2Results],
            page1Results: p1Results.length,
            page2Results: p2Results.length,
            blocked: false
        };
    } catch (error) {
        await page.close().catch(() => {});
        throw error;
    }
}

async function runTask(data) {
    const { type, query } = data;
    const startTime = Date.now();
    
    try {
        await initBrowser();

        if (type === 'search') {
            // WARM: Reuse browser and context
            const searchResults = await executeSearchTask(browser, context, query);
            
            return {
                results: searchResults.results,
                duration: Date.now() - startTime,
                workerId: process.pid,
                blocked: searchResults.blocked
            };
        }
        
        return { error: 'Unknown task type' };
    } catch (error) {
        return { 
            error: error instanceof Error ? error.message : String(error),
            duration: Date.now() - startTime
        };
    }
}

export default new ThreadWorker(runTask, {
    maxInactiveTime: 60000,
    // Warm browser initialization on worker startup
    onlineHandler: async () => {
        await initBrowser();
    },
    // Cleanup when worker exits
    exitHandler: async () => {
        if (context) await context.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
    }
});
