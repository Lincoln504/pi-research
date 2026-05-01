/**
 * Poolifier Thread Worker
 *
 * Executes search and scrape tasks in worker threads using Camoufox.
 * 
 * PRODUCTION CONFIGURATION:
 * - Browser Mode: WARM (reuses browser instances)
 * - Jitter: 200-600ms (for search only)
 * - Health Check: Integrated into worker pool
 */

/* global document, URL, setTimeout */
import { ThreadWorker } from 'poolifier';
import { createRequire } from 'module';
import * as os from 'node:os';
import process from 'node:process';

const require = createRequire(import.meta.url);

// Set worker priority to reduce system impact
try {
    os.setPriority(process.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
} catch {
    // ignore
}

// Warm browser: Reuse browser instance across tasks.
// These are safe module-level vars because poolifier is configured with
// tasksQueueOptions: { concurrency: 1 }, guaranteeing serial task execution
// per worker thread — initBrowser() is never called concurrently in one worker.
let browser = null;
let context = null;

async function initBrowser() {
    try {
        if (!browser || !browser.isConnected()) {
            let CamoufoxModule;
            try {
                CamoufoxModule = require('camoufox-js');
            } catch (e) {
                throw new Error(`[Worker] camoufox-js not found in node_modules. Please run 'npm install'. Original error: ${e.message}`);
            }

            const { Camoufox } = CamoufoxModule;
            
            // Camoufox will use process.env.HOME/USERPROFILE which we set in the pool options
            browser = await Camoufox({
                headless: true,
                humanize: true
            });
            context = await browser.newContext({
                viewport: { width: 1280, height: 800 },
            });
        } else if (!context) {
            context = await browser.newContext({
                viewport: { width: 1280, height: 800 },
            });
        }
    } catch (e) {
        browser = null;
        context = null;
        const msg = e instanceof Error ? e.message : String(e);
        
        if (msg.includes('Camoufox is not installed')) {
            throw new Error(`[Worker] Browser binaries not found. Please run 'npm run setup' to install them to the project directory.`);
        }
        
        throw e;
    }
}

async function extractSearchResults(page) {
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
            } catch {
                // ignore
            }
            if (title && url && !url.includes('duckduckgo.com') && url.startsWith('http')) {
                found.push({ title, url, content: snippet });
            }
        });
        return found;
    });
}

async function executeSearchTask(browser, context, query) {
    const page = await context.newPage();
    try {
        await page.goto('https://lite.duckduckgo.com/lite/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.fill('input[name="q"]', query);
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
            page.keyboard.press('Enter')
        ]);

        const p1Results = await extractSearchResults(page);
        let p2Results = [];
        try {
            const nextButton = page.locator('input[value="Next Page >"]');
            if (await nextButton.count() > 0) {
                await Promise.all([
                    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
                    nextButton.first().click()
                ]);
                p2Results = await extractSearchResults(page);
            }
        } catch { /* ignore */ }

        await page.close();
        const jitter = Math.floor(Math.random() * 401) + 200;
        await new Promise(r => setTimeout(r, jitter));

        return {
            results: [...p1Results, ...p2Results],
            jitter
        };
    } catch (error) {
        await page.close().catch(() => {});
        throw error;
    }
}

async function executeScrapeTask(browser, context, url) {
    const page = await context.newPage();
    try {
        // High-fidelity wait: try domcontentloaded first for speed
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        const contentType = (await response?.headerValue('content-type')) || '';
        
        if (contentType.includes('application/pdf')) {
            const buffer = await response.body();
            await page.close();
            return { contentType, buffer: Array.from(new Uint8Array(buffer)) };
        }

        // If it's HTML, check if we need to wait longer (JS-heavy sites)
        let html = await page.content();
        
        // Simple heuristic: if the body is very short, wait for networkidle
        if (html.length < 5000) {
            await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
            html = await page.content();
        }
        
        await page.close();
        return { contentType, html };
    } catch (error) {
        await page.close().catch(() => {});
        throw error;
    }
}

async function executeHealthCheck(browser, context) {
    const page = await context.newPage();
    try {
        await page.goto('https://lite.duckduckgo.com/lite/', { waitUntil: 'domcontentloaded', timeout: 10000 });
        const title = await page.title();
        await page.close();
        return { success: !!title };
    } catch (error) {
        await page.close().catch(() => {});
        throw error;
    }
}

async function runTask(data) {
    const { type, query, url } = data;
    const startTime = Date.now();
    
    try {
        await initBrowser();

        if (type === 'search') {
            const result = await executeSearchTask(browser, context, query);
            return { results: result.results, duration: Date.now() - startTime, jitter: result.jitter };
        }
        
        if (type === 'scrape') {
            const result = await executeScrapeTask(browser, context, url);
            return { ...result, duration: Date.now() - startTime };
        }

        if (type === 'healthcheck') {
            const result = await executeHealthCheck(browser, context);
            return { ...result, duration: Date.now() - startTime };
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
    onlineHandler: async () => {
        await initBrowser().catch(() => {});
    },
    exitHandler: async () => {
        if (context) await context.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
    }
});
