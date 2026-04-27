#!/usr/bin/env node
/**
 * JITTERED LONG-FORM STRESS TEST
 * 
 * Purpose: Validate DuckDuckGo Lite search robustness with 200-600ms jitter.
 * 
 * Configuration:
 * - 3 Workers (Production Config)
 * - FixedThreadPool (Production Config)
 * - 2-Page Search (High Fidelity)
 * - Random Jitter: 200-600ms per query
 * - Total Queries: 500 (Long-form)
 */

import { FixedThreadPool, WorkerChoiceStrategies } from 'poolifier';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync, appendFileSync, existsSync } from 'node:fs';
import os from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CONFIG = {
    workers: 3,
    strategy: 'LEAST_USED',
    minJitterMs: 200,
    maxJitterMs: 600,
    maxQueries: 500,
    outputDir: join(__dirname, 'jitter-stress-results'),
    searchTerms: [
        'quantum computing advances 2024',
        'renewable energy storage solutions',
        'generative ai ethics and regulation',
        'space exploration mars mission updates',
        'cybersecurity threats in banking',
        'sustainable urban development trends',
        'breakthroughs in cancer research',
        'future of electric vehicles',
        'blockchain applications in supply chain',
        'impact of microplastics on oceans',
        'advanced robotics in manufacturing',
        'developments in fusion energy',
        'privacy in the age of big data',
        'agricultural technology innovations',
        'remote work productivity studies'
    ]
};

class JitterStressTest {
    constructor() {
        this.queryCount = 0;
        this.successCount = 0;
        this.blockedCount = 0;
        this.errorCount = 0;
        this.startTime = Date.now();
        this.results = [];
        this.relevanceScores = [];
        this.workerPids = new Set();
        
        if (!existsSync(CONFIG.outputDir)) {
            mkdirSync(CONFIG.outputDir, { recursive: true });
        }
        
        this.logFile = join(CONFIG.outputDir, 'jitter-test.log');
        this.metricsFile = join(CONFIG.outputDir, 'metrics.json');
        
        writeFileSync(this.logFile, '');
        this.log('Initializing Jittered Long-Form Stress Test...');
        this.log(`Config: 3 Workers, 2-Page Search, ${CONFIG.minJitterMs}-${CONFIG.maxJitterMs}ms Jitter`);
    }

    log(msg) {
        const timestamp = new Date().toISOString();
        const line = `[${timestamp}] ${msg}`;
        console.log(line);
        appendFileSync(this.logFile, line + '\n');
    }

    getWorkerCode() {
        return `
import { ThreadWorker } from 'poolifier';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

let browser = null;
let context = null;

async function initBrowser() {
    try {
        if (!browser || !browser.isConnected()) {
            const { Camoufox } = require('camoufox-js');
            browser = await Camoufox({ headless: true, humanize: true });
            context = await browser.newContext();
        } else if (!context) {
            context = await browser.newContext();
        }
    } catch (e) {
        browser = null;
        context = null;
        throw new Error("Failed to initialize browser: " + e.message);
    }
}

async function checkBlocked(page) {
    try {
        const content = await page.content();
        const lower = content.toLowerCase();
        const blockedKeywords = [
            'access denied', 'too many requests', 'rate limit',
            'blocked', 'captcha', 'please wait', 'human verification',
            'security check', 'temporarily blocked', 'ip blocked',
            'why am i seeing this'
        ];
        return blockedKeywords.some(kw => lower.includes(kw));
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
            if (title && url && !url.includes('duckduckgo.com')) {
                found.push({ title, url, snippet });
            }
        });
        return found;
    });
}

async function runTask(data) {
    const { query, minJitter, maxJitter } = data;
    const startTime = Date.now();
    
    try {
        await initBrowser();
        if (!context) throw new Error('Browser context is null after initialization');
        
        const page = await context.newPage();
        
        await page.goto('https://lite.duckduckgo.com/lite/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        
        if (await checkBlocked(page)) {
            await page.close();
            return { blocked: true, reason: 'initial_block', duration: Date.now() - startTime, pid: process.pid };
        }
        
        await page.fill('input[name="q"]', query);
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
            page.keyboard.press('Enter')
        ]);
        
        if (await checkBlocked(page)) {
            await page.close();
            return { blocked: true, reason: 'search_block', duration: Date.now() - startTime, pid: process.pid };
        }
        
        const p1Results = await extractResults(page);
        
        let p2Results = [];
        try {
            const nextButton = page.locator('input[value="Next Page >"]');
            if (await nextButton.count() > 0) {
                await Promise.all([
                    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
                    nextButton.first().click()
                ]);
                if (!(await checkBlocked(page))) {
                    p2Results = await extractResults(page);
                }
            }
        } catch (e) {}
        
        await page.close();
        
        // Apply jitter
        const jitter = Math.floor(Math.random() * (maxJitter - minJitter + 1)) + minJitter;
        await new Promise(r => setTimeout(r, jitter));
        
        return {
            success: true,
            query,
            p1Count: p1Results.length,
            p2Count: p2Results.length,
            totalCount: p1Results.length + p2Results.length,
            duration: Date.now() - startTime,
            jitter,
            pid: process.pid
        };
    } catch (error) {
        return { error: error.message, duration: Date.now() - startTime, pid: process.pid };
    }
}

export default new ThreadWorker(runTask, { 
    maxInactiveTime: 60000,
    onlineHandler: async () => { await initBrowser(); }
});
`;
    }

    async run() {
        const workerFile = join(CONFIG.outputDir, 'worker.mjs');
        writeFileSync(workerFile, this.getWorkerCode());
        
        const pool = new FixedThreadPool(CONFIG.workers, workerFile, {
            workerChoiceStrategy: WorkerChoiceStrategies[CONFIG.strategy],
            enableTasksQueue: false
        });

        this.log('Pool started. Running queries sequentially across workers...');

        // To properly test concurrency with 3 workers, we can run them in batches or 
        // use a promise-based queue. For simplicity and jitter validation, we'll 
        // run them such that we don't overwhelm the scheduler.
        
        const activePromises = [];
        for (let i = 0; i < CONFIG.maxQueries; i++) {
            const query = `${CONFIG.searchTerms[i % CONFIG.searchTerms.length]} ${Math.floor(i / CONFIG.searchTerms.length)}`;
            
            const promise = pool.execute({ 
                query, 
                minJitter: CONFIG.minJitterMs, 
                maxJitter: CONFIG.maxJitterMs 
            }).then(result => {
                this.queryCount++;
                if (result.pid) this.workerPids.add(result.pid);
                
                if (result.success) {
                    this.successCount++;
                    if (this.queryCount % 10 === 0 || this.queryCount < 10) {
                        this.log(`[${this.queryCount}/${CONFIG.maxQueries}] ✅ Success: ${result.totalCount} results (${result.p1Count}+${result.p2Count}) in ${result.duration}ms (Jitter: ${result.jitter}ms)`);
                    }
                } else if (result.blocked) {
                    this.blockedCount++;
                    this.log(`[${this.queryCount}/${CONFIG.maxQueries}] ❌ BLOCKED: ${result.reason} (Worker: ${result.pid})`);
                } else {
                    this.errorCount++;
                    this.log(`[${this.queryCount}/${CONFIG.maxQueries}] ⚠️ ERROR: ${result.error} (Worker: ${result.pid})`);
                }
            }).catch(err => {
                this.queryCount++;
                this.errorCount++;
                this.log(`[${this.queryCount}/${CONFIG.maxQueries}] 🔥 FATAL ERROR: ${err.message}`);
            });

            activePromises.push(promise);
            
            // Limit concurrency to the number of workers to prevent CPU spikes
            if (activePromises.length >= CONFIG.workers) {
                await Promise.race(activePromises);
                // Remove finished promises
                for (let j = activePromises.length - 1; j >= 0; j--) {
                    // This is a bit hacky in JS, but works for this stress test logic
                    // In a real app we'd use a concurrency-limited map or similar
                }
                // Filter out completed promises (simplification for the test)
                // We'll just wait for all in small chunks to be safe
                if (activePromises.length >= CONFIG.workers * 2) {
                    await Promise.all(activePromises);
                    activePromises.length = 0;
                }
            }
        }

        await Promise.all(activePromises);
        this.finish(pool);
    }

    finish(pool) {
        const duration = (Date.now() - this.startTime) / 1000;
        const metrics = {
            total: this.queryCount,
            success: this.successCount,
            blocked: this.blockedCount,
            errors: this.errorCount,
            successRate: ((this.successCount / this.queryCount) * 100).toFixed(2) + '%',
            durationSeconds: duration.toFixed(1),
            throughput: (this.queryCount / duration).toFixed(3) + ' q/s',
            workers: this.workerPids.size
        };
        
        this.log('\n============================================================');
        this.log('TEST COMPLETE');
        this.log('============================================================');
        this.log(`Total Queries: ${metrics.total}`);
        this.log(`Success: ${metrics.success} (${metrics.successRate})`);
        this.log(`Blocked: ${metrics.blocked}`);
        this.log(`Errors: ${metrics.errors}`);
        this.log(`Throughput: ${metrics.throughput}`);
        this.log(`Unique Workers Used: ${metrics.workers}`);
        this.log('============================================================\n');
        
        writeFileSync(this.metricsFile, JSON.stringify(metrics, null, 2));
        pool.destroy();
        process.exit(0);
    }
}

new JitterStressTest().run().catch(err => {
    console.error('Test Failed:', err);
    process.exit(1);
});
