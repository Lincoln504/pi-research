
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
