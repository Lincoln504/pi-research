#!/usr/bin/env node
/**
 * ULTIMATE JITTER STRESS TEST (5,000 QUERIES)
 * 
 * Incorporates:
 * - 200-600ms Random Jitter
 * - 3 Workers (Production Config)
 * - 2-Page Search (High Fidelity)
 * - Relevance Scoring (Keyword Match)
 * - Block Reason Analysis (Cloudflare vs Rate Limit)
 * - Rolling Window Analysis (Hard Limit Detection)
 * - Sequential Concurrency Management (To prevent CPU spikes)
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
    maxQueries: 5000,
    rollingWindowSize: 50,
    hardLimitThreshold: 10,
    outputDir: join(__dirname, 'ultimate-stress-results'),
    searchTerms: [
        'artificial intelligence breakthroughs 2026',
        'quantum cryptography standardization',
        'sustainable fusion reactor designs',
        'neural link interface safety',
        'carbon capture efficiency metrics',
        'deep sea mineral exploration',
        'solid state battery longevity',
        'autonomous drone swarm coordination',
        'crispr gene editing ethics',
        'mars colony life support systems',
        'post-quantum encryption algorithms',
        'vertical farming yield optimization',
        'high-temperature superconductivity',
        'neuromorphic computing architecture',
        'bio-plastic degradation rates'
    ]
};

class UltimateStressTest {
    constructor() {
        this.stats = {
            total: 0,
            success: 0,
            blocked: 0,
            errors: 0,
            relevanceScores: [],
            durations: [],
            blockReasons: {},
            recoveryCount: 0,
            lastWasBlocked: false,
            rollingBlocks: []
        };
        this.startTime = Date.now();
        
        if (!existsSync(CONFIG.outputDir)) {
            mkdirSync(CONFIG.outputDir, { recursive: true });
        }
        
        this.logFile = join(CONFIG.outputDir, 'ultimate.log');
        this.resultsFile = join(CONFIG.outputDir, 'ultimate-results.json');
        
        writeFileSync(this.logFile, '');
        this.log('============================================================');
        this.log('ULTIMATE 5000-QUERY JITTER STRESS TEST');
        this.log('============================================================');
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
        }
    } catch (e) {
        browser = null;
        context = null;
        throw new Error("Browser Init Failed: " + e.message);
    }
}

async function getBlockReason(page) {
    try {
        const content = await page.content();
        const lower = content.toLowerCase();
        if (lower.includes('cloudflare') || lower.includes('cf_chl_opt')) return 'cloudflare';
        if (lower.includes('too many requests') || lower.includes('rate limit')) return 'rate_limit';
        if (lower.includes('captcha') || lower.includes('human verification')) return 'captcha';
        if (lower.includes('access denied') || lower.includes('why am i seeing this')) return 'access_denied';
        return 'unknown_block';
    } catch (e) {
        return 'content_read_error';
    }
}

function calculateRelevance(query, results) {
    if (!results || results.length === 0) return 0;
    const terms = query.toLowerCase().split(' ').filter(t => t.length > 3);
    const matches = results.reduce((acc, r) => {
        const text = (r.title + ' ' + r.snippet).toLowerCase();
        return acc + (terms.some(t => text.includes(t)) ? 1 : 0);
    }, 0);
    return Math.round((matches / results.length) * 100);
}

async function runTask(data) {
    const { query, minJitter, maxJitter } = data;
    const start = Date.now();
    try {
        await initBrowser();
        const page = await context.newPage();
        await page.goto('https://lite.duckduckgo.com/lite/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        
        const initialReason = await getBlockReason(page);
        if (initialReason !== 'unknown_block' && initialReason !== 'content_read_error') {
            await page.close();
            return { blocked: true, reason: initialReason, duration: Date.now() - start };
        }

        await page.fill('input[name="q"]', query);
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
            page.keyboard.press('Enter')
        ]);

        const searchReason = await getBlockReason(page);
        if (searchReason !== 'unknown_block' && searchReason !== 'content_read_error') {
            await page.close();
            return { blocked: true, reason: searchReason, duration: Date.now() - start };
        }

        const extract = () => Array.from(document.querySelectorAll('a.result-link')).map(link => {
            const row = link.closest('tr');
            return {
                title: link.textContent.trim(),
                url: link.href,
                snippet: row?.nextElementSibling?.querySelector('td.result-snippet')?.textContent?.trim() || ''
            };
        });

        const p1 = await page.evaluate(extract);
        let p2 = [];
        try {
            const next = page.locator('input[value="Next Page >"]');
            if (await next.count() > 0) {
                await Promise.all([
                    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
                    next.first().click()
                ]);
                p2 = await page.evaluate(extract);
            }
        } catch (e) {}

        await page.close();
        const results = [...p1, ...p2];
        const relevance = calculateRelevance(query, results);
        
        const jitter = Math.floor(Math.random() * (maxJitter - minJitter + 1)) + minJitter;
        await new Promise(r => setTimeout(r, jitter));

        return { success: true, count: results.length, relevance, duration: Date.now() - start, jitter };
    } catch (e) {
        return { error: e.message, duration: Date.now() - start };
    }
}

export default new ThreadWorker(runTask, { maxInactiveTime: 60000 });
`;
    }

    async run() {
        const workerFile = join(CONFIG.outputDir, 'ultimate-worker.mjs');
        writeFileSync(workerFile, this.getWorkerCode());
        
        const pool = new FixedThreadPool(CONFIG.workers, workerFile, {
            workerChoiceStrategy: WorkerChoiceStrategies[CONFIG.strategy]
        });

        const activePromises = new Set();
        
        for (let i = 0; i < CONFIG.maxQueries; i++) {
            const query = `${CONFIG.searchTerms[i % CONFIG.searchTerms.length]} ${i}`;
            
            const promise = pool.execute({ query, minJitter: CONFIG.minJitterMs, maxJitter: CONFIG.maxJitterMs })
                .then(res => this.handleResult(res, i))
                .finally(() => activePromises.delete(promise));

            activePromises.add(promise);
            
            if (activePromises.size >= CONFIG.workers) {
                await Promise.race(activePromises);
            }
            
            if (this.stats.rollingBlocks.length >= CONFIG.hardLimitThreshold) {
                this.log('🚨 HARD LIMIT REACHED IN ROLLING WINDOW. STOPPING.');
                break;
            }
        }

        await Promise.all(activePromises);
        this.finish(pool);
    }

    handleResult(res, index) {
        this.stats.total++;
        if (res.success) {
            this.stats.success++;
            this.stats.relevanceScores.push(res.relevance);
            this.stats.durations.push(res.duration);
            if (this.stats.lastWasBlocked) this.stats.recoveryCount++;
            this.stats.lastWasBlocked = false;
            
            // Clean up rolling window
            this.stats.rollingBlocks = this.stats.rollingBlocks.filter(b => b > index - CONFIG.rollingWindowSize);

            if (this.stats.total % 25 === 0) {
                const avgRel = (this.stats.relevanceScores.reduce((a,b)=>a+b,0)/this.stats.relevanceScores.length).toFixed(1);
                this.log(`[${this.stats.total}/${CONFIG.maxQueries}] ✅ Success | Rel: ${avgRel}% | Dur: ${res.duration}ms | Jitter: ${res.jitter}ms`);
            }
        } else if (res.blocked) {
            this.stats.blocked++;
            this.stats.lastWasBlocked = true;
            this.stats.rollingBlocks.push(index);
            this.stats.blockReasons[res.reason] = (this.stats.blockReasons[res.reason] || 0) + 1;
            this.log(`[${this.stats.total}/${CONFIG.maxQueries}] ❌ BLOCKED: ${res.reason} | Window: ${this.stats.rollingBlocks.length}/${CONFIG.hardLimitThreshold}`);
        } else {
            this.stats.errors++;
            this.log(`[${this.stats.total}/${CONFIG.maxQueries}] ⚠️ ERROR: ${res.error}`);
        }
    }

    finish(pool) {
        const duration = (Date.now() - this.startTime) / 1000;
        const finalResults = {
            config: CONFIG,
            durationSeconds: duration,
            stats: this.stats,
            throughput: (this.stats.total / duration).toFixed(3)
        };
        
        writeFileSync(this.resultsFile, JSON.stringify(finalResults, null, 2));
        this.log('\n============================================================');
        this.log('TEST COMPLETE');
        this.log(`Throughput: ${finalResults.throughput} q/s`);
        this.log(`Final Success Rate: ${((this.stats.success/this.stats.total)*100).toFixed(2)}%`);
        this.log(`Total Blocks: ${this.stats.blocked} | Recoveries: ${this.stats.recoveryCount}`);
        this.log('============================================================\n');
        pool.destroy();
        process.exit(0);
    }
}

new UltimateStressTest().run();
