/**
 * Poolifier Worker
 *
 * Executes search and scrape tasks in worker processes using Camoufox.
 */

/* global document, URL, setTimeout, setInterval */
import { ClusterWorker } from 'poolifier';
import { createRequire } from 'node:module';
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

// Orphaned worker protection: If parent dies, kill the worker.
// This works cross-platform (Linux, Mac, Windows) in Node.js.
if (process.ppid) {
    setInterval(() => {
        try {
            // signal 0 checks if the process is alive
            process.kill(process.ppid, 0);
        } catch (_e) {
            // If error is thrown, the parent process is likely dead or unreachable
            logToDebugFile('WARN', `[Worker-${workerId}] Parent process died or unreachable (orphaned), shutting down...`);
            if (context) context.close().catch(() => {});
            if (browser) browser.close().catch(() => {});
            process.exit(1);
        }
    }, 10000);
}

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
    const SCRAPE_TIMEOUT = parseInt(process.env.PI_RESEARCH_SCRAPE_TIMEOUT_MS || '15000', 10);
    page.setDefaultTimeout(SCRAPE_TIMEOUT);
    page.setDefaultNavigationTimeout(SCRAPE_TIMEOUT);
    
    try {
                logToDebugFile('DEBUG', `[Worker-${workerId}] Starting scrape for: ${url}`);
        // High-fidelity wait: try domcontentloaded first for speed
        const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
        const contentType = (await response?.headerValue('content-type')) || '';
        
        if (contentType.includes('application/pdf')) {
            if (!response) throw new Error(`[Worker] No response received for PDF URL: ${url}`);
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

async function executeHealthCheckAttempt(browser, context, navTimeoutMs) {
    const page = await context.newPage();
    page.setDefaultTimeout(navTimeoutMs);
    page.setDefaultNavigationTimeout(navTimeoutMs);

    try {
        const navStart = Date.now();
        await page.goto('https://lite.duckduckgo.com/lite/', { waitUntil: 'domcontentloaded' });
        const navMs = Date.now() - navStart;

        if (navMs > 3000) {
            logToDebugFile('WARN', `[Worker-${workerId}] DDG Lite navigation was slow: ${navMs}ms (expected <1s). Possible rate-limit or network congestion.`);
        }

        const title = await page.title();
        await page.close();
        return { success: !!title, navMs };
    } catch (error) {
        await page.close().catch(() => {});
        throw error;
    }
}

async function executeHealthCheck(browser, context) {
    // Nav timeout: read from env (passed through getBrowserEnv), floor at 10s.
    // The outer BrowserTaskScheduler.runHealthCheck() has its own 45s hard deadline.
    const configuredMs = parseInt(process.env.PI_RESEARCH_HEALTH_CHECK_TIMEOUT_MS || '0', 10);
    const HEALTH_TIMEOUT = configuredMs > 0 ? Math.max(10000, configuredMs) : 10000;

    try {
        return await executeHealthCheckAttempt(browser, context, HEALTH_TIMEOUT);
    } catch (firstError) {
        // One retry: if the first attempt fails, the page may have been in a bad state
        // (challenge redirect, partial load, transient network blip). A second attempt
        // on a fresh page helps distinguish a real outage from a one-off failure.
        logToDebugFile('WARN', `[Worker-${workerId}] Health check attempt 1 failed: ${firstError.message}. Retrying once...`);
        try {
            return await executeHealthCheckAttempt(browser, context, HEALTH_TIMEOUT);
        } catch (retryError) {
            logToDebugFile('ERROR', `[Worker-${workerId}] Health check failed after retry: ${retryError.message}`);
            throw retryError;
        }
    }
}

async function runTask(data) {
    const { type, query, url } = data;
    const startTime = Date.now();
        logToDebugFile('DEBUG', `[Worker-${workerId}] Received task: ${type}`);

    try {
        await initBrowser();
        const initMs = Date.now() - startTime;

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
            if (initMs > 3000) {
                logToDebugFile('WARN', `[Worker-${workerId}] Browser init was slow: ${initMs}ms — leaving less headroom for DDG navigation.`);
            }
            const result = await executeHealthCheck(browser, context);
            logToDebugFile('DEBUG', `[Worker-${workerId}] Healthcheck: browser init ${initMs}ms, nav ${result.navMs ?? '?'}ms`);
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
        // Force process exit — without this, the orphan-detection setInterval keeps
        // the event loop alive indefinitely after the IPC channel is disconnected.
        process.exit(0);
    }
});
