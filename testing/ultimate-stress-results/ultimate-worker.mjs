
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
