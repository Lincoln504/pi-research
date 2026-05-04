/**
 * Poolifier Worker
 *
 * Executes search and scrape tasks in worker processes using Camoufox.
 */

/* global document, URL, setTimeout */
import { ClusterWorker } from 'poolifier';
import { createRequire } from 'module';
import * as fs from 'node:fs';
import process from 'node:process';
import cluster from 'node:cluster';

const require = createRequire(import.meta.url);

// Handle ERR_IPC_CHANNEL_CLOSED when poolifier tries to send messages during shutdown
if (cluster.isWorker && cluster.worker) {
    cluster.worker.on('error', (err) => {
        if (err && err.code === 'ERR_IPC_CHANNEL_CLOSED') {
            return;
        }
        throw err;
    });
}

// Generate a random ID for this worker process to track distribution in logs
const workerId = Math.random().toString(36).substring(2, 6);

/**
 * File-based logger for workers that mirrors the main process format
 */
function logToDebugFile(level, ...args) {
    const logFile = process.env.PI_RESEARCH_LOG_FILE;
    if (!logFile) return;

    try {
        const timestamp = new Date().toISOString();
        const entry = {
            timestamp,
            level,
            workerId,
            message: args.map(arg => {
                if (arg instanceof Error) return arg.stack || arg.message;
                if (typeof arg === 'object' && arg !== null) return JSON.stringify(arg);
                return String(arg);
            }).join(' ')
        };
        fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
    } catch {
        // ignore
    }
}

// Warm browser: Reuse browser instance across tasks.
let browser = null;
let context = null;
let initPromise = null;

async function initBrowser() {
    const isBrowserConnected = () => {
        try {
            return browser && typeof browser.isConnected === 'function' && browser.isConnected();
        } catch {
            return false;
        }
    };

    if (isBrowserConnected() && context) return;

    if (initPromise) return initPromise;

    initPromise = (async () => {
        try {
            if (!isBrowserConnected() || !context) {
                logToDebugFile('INFO', `[Worker-${workerId}] Initializing browser instance...`);

                let CamoufoxModule;
                try {
                    CamoufoxModule = require('camoufox-js');
                } catch (e) {
                    throw new Error(`[Worker] camoufox-js not found in node_modules. Please run 'npm install'. Original error: ${e.message}`, { cause: e });
                }

                const { Camoufox } = CamoufoxModule;

                // Launch browser without user_data_dir so Playwright creates an isolated
                // temp profile per instance. This avoids persistent-context semantics
                // (where context.browser() returns null) and the profile-lock contention
                // that came with sharing a single user_data_dir path.
                browser = await Camoufox({
                    headless: true,
                    humanize: true,
                });

                context = await browser.newContext({
                    viewport: { width: 1280, height: 800 },
                });

                logToDebugFile('INFO', `[Worker-${workerId}] Browser initialized.`);
            }
        } catch (e) {
            browser = null;
            context = null;
            const msg = e instanceof Error ? e.message : String(e);

            if (msg.includes('Camoufox is not installed') || msg.includes('Version information not found')) {
                throw new Error(`[Worker] Browser binaries not found. Please run 'npm run setup' to install them.`, { cause: e });
            }

            throw e;
        } finally {
            initPromise = null;
        }
    })();

    return initPromise;
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
    const SEARCH_TIMEOUT = 12000;
    page.setDefaultTimeout(SEARCH_TIMEOUT);
    page.setDefaultNavigationTimeout(SEARCH_TIMEOUT);
    
    try {
                logToDebugFile('DEBUG', `[Worker-${workerId}] Starting search for: ${query}`);
        // Tighten timeouts: DDG Lite is fast, 10-15s should be plenty
        await page.goto('https://lite.duckduckgo.com/lite/', { waitUntil: 'domcontentloaded' });
        await page.fill('input[name="q"]', query);
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
            page.keyboard.press('Enter')
        ]);

        const results = await extractSearchResults(page);

        await page.close();
        const jitter = Math.floor(Math.random() * 401) + 200;
        await new Promise(r => setTimeout(r, jitter));

        return { results, jitter };
    } catch (error) {
        await page.close().catch(() => {});
        throw error;
    }
}

async function executeScrapeTask(browser, context, url) {
    const page = await context.newPage();
    const SCRAPE_TIMEOUT = 10000;
    page.setDefaultTimeout(SCRAPE_TIMEOUT);
    page.setDefaultNavigationTimeout(SCRAPE_TIMEOUT);
    
    try {
                logToDebugFile('DEBUG', `[Worker-${workerId}] Starting scrape for: ${url}`);
        // High-fidelity wait: try domcontentloaded first for speed
        const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
        const contentType = (await response?.headerValue('content-type')) || '';
        
        if (contentType.includes('application/pdf')) {
            const buffer = await response.body();
            await page.close();
            return { contentType, buffer };
        }

        // If it's HTML, check if we need to wait longer (JS-heavy sites)
        let html = await page.content();
        
        // Improved heuristic: wait if very short OR if it contains common SPA mount points
        const needsWait = html.length < 5000 || 
                          html.includes('id="root"') || 
                          html.includes('id="app"') ||
                          html.includes('<noscript>');

        if (needsWait) {
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
    const HEALTH_TIMEOUT = 10000;
    page.setDefaultTimeout(HEALTH_TIMEOUT);
    page.setDefaultNavigationTimeout(HEALTH_TIMEOUT);
    
    try {
        await page.goto('https://lite.duckduckgo.com/lite/', { waitUntil: 'domcontentloaded' });
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
        logToDebugFile('DEBUG', `[Worker-${workerId}] Received task: ${type}`);
    
    try {
        await initBrowser();

        if (type === 'search') {
            const result = await executeSearchTask(browser, context, query);
                        logToDebugFile('DEBUG', `[Worker-${workerId}] Search completed in ${Date.now() - startTime}ms`);
            return { results: result.results, duration: Date.now() - startTime, jitter: result.jitter };
        }
        
        if (type === 'scrape') {
            const result = await executeScrapeTask(browser, context, url);
                        logToDebugFile('DEBUG', `[Worker-${workerId}] Scrape completed in ${Date.now() - startTime}ms`);
            return { ...result, duration: Date.now() - startTime };
        }

        if (type === 'healthcheck') {
            const result = await executeHealthCheck(browser, context);
            return { ...result, duration: Date.now() - startTime };
        }
        
        return { error: 'Unknown task type' };
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
                logToDebugFile('ERROR', `[Worker-${workerId}] Task failed: ${errMsg}`);
        
        // If the browser crashed or disconnected, clear the instance to force re-initialization on next task
        if (errMsg.includes('Target closed') || 
            errMsg.includes('browser has disconnected') || 
            errMsg.includes('Protocol error') ||
            errMsg.includes('Session closed')) {
            if (context) context.close().catch(() => {});
            if (browser) browser.close().catch(() => {});
            context = null;
            browser = null;
        }

        return { 
            error: errMsg,
            duration: Date.now() - startTime
        };
    }
}

export default new ClusterWorker(runTask, {
    onlineHandler: async () => {
        logToDebugFile('INFO', `[Worker-${workerId}] Worker online and ready for tasks`);
        await initBrowser().catch(() => {});
    },
    killHandler: async () => {
        logToDebugFile('INFO', `[Worker-${workerId}] Worker shutting down`);
        if (context) await context.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
    }
});
