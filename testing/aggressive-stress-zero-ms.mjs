#!/usr/bin/env node
/**
 * AGGRESSIVE STRESS TEST @ 0ms Throttle
 * 
 * Location: /home/ldeen/Documents/pi-research/testing/aggressive-stress-zero-ms.mjs
 * 
 * Purpose: Push DuckDuckGo Lite to ABSOLUTE LIMIT with NO DELAY between queries
 * 
 * Configuration:
 * - 4 concurrent workers (max parallelism)
 * - 0ms throttle (NO DELAY - as fast as possible)
 * - 2-page search (results from page 1 and page 2)
 * - Relevance checking (word similarity scoring)
 * - Run until hard limit or consistent blocking detected
 * - Robust error detection for rate limiting
 * 
 * This is the MOST AGGRESSIVE test possible - queries run back-to-back with NO DELAY
 * 
 * NOTE: This test is NOT part of the CI pipeline. It is for manual performance testing only.
 */

import { Camoufox } from 'camoufox-js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const fs = require('fs');
const path = require('path');

const CONFIG = {
    throttleMs: 0,               // NO DELAY - as fast as possible
    workers: 4,                   // Max parallelism
    queriesPerBatch: 10,         // Batch size for 4 workers
    maxQueries: 2000,            // Run up to 2000 queries (or until hard limit)
    maxConsecutiveBlocks: 5,      // Consider consistent limit after 5 consecutive blocks
    hardLimitBlockThreshold: 10,  // Hard limit if blocked 10 times in 50 queries
    rollingWindowSize: 50,        // Check rolling window for blocks
    outputDir: '/tmp/aggressive-stress-zero-ms'
};

if (!fs.existsSync(CONFIG.outputDir)) {
    fs.mkdirSync(CONFIG.outputDir, { recursive: true });
}

const LOG_FILE = path.join(CONFIG.outputDir, 'aggressive-stress-zero-ms.log');
const RESULTS_FILE = path.join(CONFIG.outputDir, 'aggressive-stress-zero-ms.json');

// Statistics tracking
const stats = {
    totalQueries: 0,
    success: 0,
    blocked: 0,
    errors: 0,
    consecutiveBlocks: 0,
    maxConsecutiveBlocks: 0,
    blockIndices: [],
    lastBlockIndex: -1,
    rollingWindowBlocks: [],
    hitHardLimit: false,
    hitConsistentLimit: false,
    startTime: null,
    relevanceScores: [],
    page1Results: 0,
    page2Results: 0,
    page2Successes: 0,
    blockReasons: {},
    queryDurations: [],
    firstBlockIndex: -1,
    recoveryCount: 0
};

function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    fs.appendFileSync(LOG_FILE, line + '\n');
}

function checkIfBlocked(content) {
    const lower = content.toLowerCase();
    return /why am i seeing this|you have been blocked|access denied|please complete|cloudflare|ddos.*guard|too many requests|rate.*limit|429.*too|captcha.*please|are you.*human/i.test(lower);
}

function getBlockReason(content) {
    const lower = content.toLowerCase();
    if (/why am i seeing this|you have been blocked/i.test(lower)) return 'blocked_page';
    if (/cloudflare|cf_chl_opt|__cf_/i.test(lower)) return 'cloudflare';
    if (/ddos.*guard/i.test(lower)) return 'ddos_guard';
    if (/captcha.*please|are you.*human/i.test(lower)) return 'captcha';
    if (/too many requests|rate.*limit|429.*too/i.test(lower)) return 'rate_limit';
    if (/access.*denied|forbidden|http 403/i.test(lower)) return 'access_denied';
    return 'unknown';
}

async function extractResults(page) {
    return await page.evaluate(() => {
        const found = [];
        
        // Try multiple selectors for results
        const selectors = [
            'a.result-link',
            'a[href*="/uddg="]',
            'a.result__a',
            'a[class*="result"]'
        ];
        
        for (const selector of selectors) {
            const links = Array.from(document.querySelectorAll(selector));
            
            for (const link of links) {
                const title = link.textContent?.trim() || '';
                let url = link.href || '';
                
                // Decode DuckDuckGo redirect URLs
                try {
                    if (url.includes('duckduckgo.com/l/')) {
                        const u = new URL(url);
                        const uddg = u.searchParams.get('uddg');
                        if (uddg) url = decodeURIComponent(uddg);
                    }
                } catch (e) {}
                
                // Get snippet
                const row = link.closest('tr') || link.closest('td')?.parentElement;
                let snippet = '';
                if (row?.nextElementSibling) {
                    snippet = row.nextElementSibling.textContent?.trim().substring(0, 300) || '';
                } else {
                    const parent = link.parentElement;
                    if (parent) {
                        snippet = parent.textContent.replace(title, '').trim().substring(0, 300);
                    }
                }
                
                // Skip DDG links, non-HTTP, empty, or duplicates
                if (url && !url.includes('duckduckgo.com') && url.startsWith('http') && title && !found.find(f => f.url === url)) {
                    found.push({ title, url, snippet });
                }
                
                if (found.length >= 10) break;
            }
            
            if (found.length >= 5) break;
        }
        
        return found;
    });
}

function calculateRelevance(query, results) {
    if (!results || results.length === 0) {
        return { score: 0, matchCount: 0, matchedTerms: [], coverage: 0 };
    }
    
    const queryTerms = query
        .toLowerCase()
        .split(/[\s,;:.!?()]+/)
        .filter(t => t.length > 2);
    
    if (queryTerms.length === 0) {
        return { score: 0, matchCount: 0, matchedTerms: [], coverage: 0 };
    }
    
    const allText = results
        .map(r => (r.title + ' ' + r.snippet).toLowerCase())
        .join(' ');
    
    let matchCount = 0;
    const matchedTerms = [];
    
    for (const term of queryTerms) {
        const regex = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
        const matches = allText.match(regex);
        const count = matches ? matches.length : 0;
        
        if (count > 0) {
            matchCount += count;
            matchedTerms.push({ term, count });
        }
    }
    
    const baseScore = (matchedTerms.length / queryTerms.length) * 50;
    const freqBonus = Math.min(matchCount * 2, 50);
    const score = Math.round(baseScore + freqBonus);
    const coverage = Math.round((matchedTerms.length / queryTerms.length) * 100);
    
    return { score, matchCount, matchedTerms, coverage };
}

async function performSearch(query, queryNum, throttleMs) {
    const startTime = Date.now();
    
    let browser = null;
    try {
        browser = await Camoufox({
            headless: true,
            humanize: false  // Speed up for aggressive test
        });
        
        const context = await browser.newContext();
        const page = await context.newPage();
        
        // Navigate to DDG Lite
        await page.goto('https://lite.duckduckgo.com/lite/', { 
            waitUntil: 'domcontentloaded', 
            timeout: 30000 
        });
        
        // Check for initial block
        let content = await page.content();
        if (checkIfBlocked(content)) {
            await browser.close();
            return {
                queryNum,
                query,
                throttleMs,
                startTime,
                endTime: Date.now(),
                duration: Date.now() - startTime,
                success: false,
                blocked: true,
                blockReason: getBlockReason(content),
                results: [],
                resultCount: 0,
                pageCount: 0,
                page2Success: false,
                relevance: { score: 0, matchCount: 0, matchedTerms: [], coverage: 0 }
            };
        }
        
        // Fill and submit search
        await page.fill('input[name="q"]', query);
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
            page.keyboard.press('Enter')
        ]);
        
        await new Promise(resolve => setTimeout(resolve, 200));  // Reduced wait time
        
        content = await page.content();
        
        // Check for block after search
        if (checkIfBlocked(content)) {
            await browser.close();
            return {
                queryNum,
                query,
                throttleMs,
                startTime,
                endTime: Date.now(),
                duration: Date.now() - startTime,
                success: false,
                blocked: true,
                blockReason: getBlockReason(content),
                results: [],
                resultCount: 0,
                pageCount: 0,
                page2Success: false,
                relevance: { score: 0, matchCount: 0, matchedTerms: [], coverage: 0 }
            };
        }
        
        // Extract results from page 1
        const resultsP1 = await extractResults(page);
        
        // Try to click "Next Page >" button for page 2
        let resultsP2 = [];
        let page2Success = false;
        
        try {
            const nextButton = page.locator('input[value="Next Page >"]');
            if (await nextButton.count() > 0) {
                await Promise.all([
                    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
                    nextButton.first().click()
                ]);
                
                await new Promise(resolve => setTimeout(resolve, 200));  // Reduced wait time
                
                const contentP2 = await page.content();
                
                if (!checkIfBlocked(contentP2)) {
                    resultsP2 = await extractResults(page);
                    page2Success = true;
                }
            }
        } catch (error) {
            // Next page failed, continue with page 1 results only
        }
        
        await browser.close();
        
        // Combine results from both pages
        const allResults = [...resultsP1, ...resultsP2];
        
        // Calculate relevance
        const relevance = calculateRelevance(query, allResults);
        
        return {
            queryNum,
            query,
            throttleMs,
            startTime,
            endTime: Date.now(),
            duration: Date.now() - startTime,
            success: true,
            blocked: false,
            blockReason: null,
            results: allResults,
            resultCount: allResults.length,
            page1Results: resultsP1.length,
            page2Results: resultsP2.length,
            page2Success,
            pageCount: 1 + (page2Success ? 1 : 0),
            relevance
        };
        
    } catch (error) {
        if (browser) await browser.close();
        return {
            queryNum,
            query,
            throttleMs,
            startTime,
            endTime: Date.now(),
            duration: Date.now() - startTime,
            success: false,
            blocked: false,
            blockReason: null,
            error: error.message,
            results: [],
            resultCount: 0,
            pageCount: 0,
            page2Success: false,
            relevance: { score: 0, matchCount: 0, matchedTerms: [], coverage: 0 }
        };
    }
}

function analyzeRateLimitPattern(blockIndices) {
    if (blockIndices.length === 0) {
        return { pattern: 'none', detected: false, analysis: 'No blocks detected' };
    }
    
    // Check for gaps
    const gaps = [];
    for (let i = 1; i < blockIndices.length; i++) {
        gaps.push(blockIndices[i] - blockIndices[i-1]);
    }
    
    const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const minGap = Math.min(...gaps);
    const maxGap = Math.max(...gaps);
    
    // Check consecutive blocks
    let consecutiveCount = 0;
    let maxConsecutive = 0;
    for (let i = 1; i < blockIndices.length; i++) {
        if (blockIndices[i] === blockIndices[i-1] + 1) {
            consecutiveCount++;
            maxConsecutive = Math.max(maxConsecutive, consecutiveCount);
        } else {
            consecutiveCount = 0;
        }
    }
    
    // Check for clustering
    const clusters = [];
    let currentCluster = [blockIndices[0]];
    for (let i = 1; i < blockIndices.length; i++) {
        if (blockIndices[i] - blockIndices[i-1] <= 10) {
            currentCluster.push(blockIndices[i]);
        } else {
            if (currentCluster.length >= 2) {
                clusters.push([...currentCluster]);
            }
            currentCluster = [blockIndices[i]];
        }
    }
    if (currentCluster.length >= 2) {
        clusters.push(currentCluster);
    }
    
    // Determine pattern
    let pattern = 'unknown';
    let detected = false;
    let analysis = '';
    
    if (blockIndices.length >= CONFIG.hardLimitBlockThreshold) {
        // Check if clustered
        if (clusters.length > 0 && clusters.some(c => c.length >= 5)) {
            pattern = 'clustered_rate_limit';
            detected = true;
            analysis = `Hard rate limit detected: ${blockIndices.length} blocks with clustering pattern`;
        } else if (avgGap < 20) {
            pattern = 'tight_rate_limit';
            detected = true;
            analysis = `Hard rate limit detected: ${blockIndices.length} blocks with tight gaps (avg: ${avgGap.toFixed(1)})`;
        } else {
            pattern = 'sporadic_blocks';
            detected = false;
            analysis = `Sporadic blocks detected: ${blockIndices.length} blocks with loose gaps (avg: ${avgGap.toFixed(1)})`;
        }
    } else {
        pattern = 'sporadic_blocks';
        detected = false;
        analysis = `Sporadic blocks detected: ${blockIndices.length} blocks (below threshold)`;
    }
    
    return {
        pattern,
        detected,
        analysis,
        statistics: {
            totalBlocks: blockIndices.length,
            avgGap: avgGap.toFixed(1),
            minGap,
            maxGap,
            maxConsecutive,
            clusters: clusters.length,
            maxClusterSize: clusters.length > 0 ? Math.max(...clusters.map(c => c.length)) : 0
        }
    };
}

async function runAggressiveStressTest() {
    log('\n' + '='.repeat(70));
    log('AGGRESSIVE STRESS TEST @ 0ms THROTTLE');
    log('='.repeat(70));
    log(`Purpose: Push DuckDuckGo Lite to ABSOLUTE LIMIT with NO DELAY`);
    log(`Configuration:`);
    log(`  - Throttle: ${CONFIG.throttleMs}ms (NO DELAY - as fast as possible)`);
    log(`  - Workers: ${CONFIG.workers} (max parallelism)`);
    log(`  - 2-Page Search: ENABLED`);
    log(`  - Relevance Checking: ENABLED`);
    log(`  - Max Queries: ${CONFIG.maxQueries} (or until hard limit)`);
    log(`  - Consistent Limit Threshold: ${CONFIG.maxConsecutiveBlocks} consecutive blocks`);
    log(`  - Hard Limit Threshold: ${CONFIG.hardLimitBlockThreshold} blocks in ${CONFIG.rollingWindowSize} queries`);
    log(`Date: ${new Date().toISOString()}`);
    log('='.repeat(70) + '\n');

    stats.startTime = Date.now();
    
    const testTerms = [
        'artificial intelligence', 'machine learning', 'deep learning', 'neural networks',
        'blockchain', 'cryptocurrency', 'quantum computing', 'robotics',
        'natural language processing', 'computer vision', 'cybersecurity', 'cloud computing'
    ];
    
    // Generate query list
    const queries = [];
    for (let i = 0; i < CONFIG.maxQueries; i++) {
        queries.push(`${testTerms[i % testTerms.length]} ${i}`);
    }
    
    log(`Generated ${queries.length} queries to test`);
    log(`Starting aggressive stress test with 0ms throttle...\n`);
    
    // Process queries in batches of 10 (for 4 workers)
    for (let batchStart = 0; batchStart < queries.length; batchStart += CONFIG.queriesPerBatch) {
        // Check stopping conditions
        if (stats.hitHardLimit) {
            log('\n' + '='.repeat(70));
            log('🚨 HARD LIMIT REACHED');
            log('='.repeat(70));
            log(`Stopping test at query ${batchStart}`);
            log(`Reason: Hard limit threshold (${CONFIG.hardLimitBlockThreshold} blocks in ${CONFIG.rollingWindowSize} queries) exceeded`);
            break;
        }
        
        if (stats.hitConsistentLimit) {
            log('\n' + '='.repeat(70));
            log('⚠️  CONSISTENT LIMIT REACHED');
            log('='.repeat(70));
            log(`Stopping test at query ${batchStart}`);
            log(`Reason: Consistent limit threshold (${CONFIG.maxConsecutiveBlocks} consecutive blocks) exceeded`);
            break;
        }
        
        // Get batch of queries
        const batch = queries.slice(batchStart, Math.min(batchStart + CONFIG.queriesPerBatch, queries.length));
        
        // Run with 4 workers concurrently (NO DELAY)
        const promises = batch.map(async (q, idx) => {
            const result = await performSearch(q, batchStart + idx, CONFIG.throttleMs);
            result.workerId = (batchStart + idx) % CONFIG.workers;
            return result;
        });
        
        const results = await Promise.all(promises);
        
        // Process results
        for (const result of results) {
            stats.totalQueries++;
            
            if (result.success) {
                stats.success++;
                stats.page1Results += result.page1Results;
                stats.page2Results += result.page2Results;
                if (result.page2Success) stats.page2Successes++;
                stats.consecutiveBlocks = 0;
                stats.rollingWindowBlocks = [];
                
                // Track recovery (block -> success)
                if (stats.lastBlockIndex > -1) {
                    stats.recoveryCount++;
                }
                
                stats.relevanceScores.push(result.relevance.score);
                stats.queryDurations.push(result.duration);
                
                log(`[${result.queryNum + 1}] ✅ | P1:${result.page1Results} P2:${result.page2Results} Total:${result.resultCount} | Rel:${result.relevance.score}% | ${result.duration}ms | BlockGap:${stats.lastBlockIndex > -1 ? result.queryNum - stats.lastBlockIndex : 'N/A'}`);
            } else if (result.blocked) {
                stats.blocked++;
                stats.consecutiveBlocks++;
                stats.maxConsecutiveBlocks = Math.max(stats.maxConsecutiveBlocks, stats.consecutiveBlocks);
                stats.blockIndices.push(result.queryNum);
                
                if (stats.firstBlockIndex === -1) {
                    stats.firstBlockIndex = result.queryNum;
                }
                stats.lastBlockIndex = result.queryNum;
                stats.rollingWindowBlocks.push(result.queryNum);
                
                // Track block reasons
                if (!stats.blockReasons[result.blockReason]) {
                    stats.blockReasons[result.blockReason] = 0;
                }
                stats.blockReasons[result.blockReason]++;
                
                // Check consistent limit
                if (stats.consecutiveBlocks >= CONFIG.maxConsecutiveBlocks) {
                    stats.hitConsistentLimit = true;
                }
                
                // Check hard limit (rolling window)
                if (stats.rollingWindowBlocks.length >= CONFIG.hardLimitBlockThreshold) {
                    stats.hitHardLimit = true;
                }
                
                log(`[${result.queryNum + 1}] ❌ BLOCKED | ${result.blockReason} | ${result.duration}ms | Consecutive:${stats.consecutiveBlocks} | Rolling:${stats.rollingWindowBlocks.length}/${CONFIG.hardLimitBlockThreshold}`);
            } else {
                stats.errors++;
                stats.consecutiveBlocks = 0;
                stats.rollingWindowBlocks = [];
                
                log(`[${result.queryNum + 1}] ⚠️  ERROR | ${result.error} | ${result.duration}ms`);
            }
        }
        
        // Progress logging
        if (batchStart > 0 && batchStart % 50 === 0) {
            const elapsed = (Date.now() - stats.startTime) / 1000;
            const successRate = ((stats.success / stats.totalQueries) * 100).toFixed(2);
            const blockRate = ((stats.blocked / stats.totalQueries) * 100).toFixed(2);
            const avgRel = stats.relevanceScores.length > 0 
                ? (stats.relevanceScores.reduce((a,b) => a+b, 0) / stats.relevanceScores.length).toFixed(2) 
                : 0;
            const throughput = (stats.totalQueries / elapsed).toFixed(4);
            const avgPage1 = stats.success > 0 ? (stats.page1Results / stats.success).toFixed(1) : 0;
            const avgPage2 = stats.success > 0 ? (stats.page2Results / stats.success).toFixed(1) : 0;
            const page2Rate = stats.success > 0 ? ((stats.page2Successes / stats.success) * 100).toFixed(1) : 0;
            
            log('\n' + '-'.repeat(70));
            log(`PROGRESS @ Query ${batchStart} (${batchStart}/${queries.length})`);
            log('-'.repeat(70));
            log(`  Elapsed: ${elapsed.toFixed(1)}s`);
            log(`  Queries: ${stats.totalQueries} | Success: ${stats.success} (${successRate}%) | Blocked: ${stats.blocked} (${blockRate}%) | Errors: ${stats.errors}`);
            log(`  Consecutive Blocks: ${stats.consecutiveBlocks} | Max: ${stats.maxConsecutiveBlocks}`);
            log(`  Rolling Window Blocks: ${stats.rollingWindowBlocks.length}/${CONFIG.hardLimitBlockThreshold}`);
            log(`  Throughput: ${throughput} queries/sec`);
            log(`  Page Stats: Avg P1:${avgPage1} | Avg P2:${avgPage2} | Total:${parseFloat(avgPage1) + parseFloat(avgPage2)} | P2 Success:${page2Rate}%`);
            log(`  Relevance: Avg ${avgRel}% | High: ${stats.relevanceScores.filter(s => s >= 70).length}/${stats.relevanceScores.length}`);
            log(`  First Block: ${stats.firstBlockIndex > -1 ? stats.firstBlockIndex : 'N/A'} | Recoveries: ${stats.recoveryCount}`);
            log(`  Status: ${stats.hitHardLimit ? '🚨 HARD LIMIT' : stats.hitConsistentLimit ? '⚠️ CONSISTENT LIMIT' : '✅ CONTINUING'}`);
        }
    }
    
    // Test completed - compile final results
    const testDuration = Date.now() - stats.startTime;
    const successRate = ((stats.success / stats.totalQueries) * 100).toFixed(2);
    const blockRate = ((stats.blocked / stats.totalQueries) * 100).toFixed(2);
    const avgRel = stats.relevanceScores.length > 0 
        ? (stats.relevanceScores.reduce((a,b) => a+b, 0) / stats.relevanceScores.length).toFixed(2) 
        : 0;
    const avgPage1 = stats.success > 0 ? (stats.page1Results / stats.success).toFixed(1) : 0;
    const avgPage2 = stats.success > 0 ? (stats.page2Results / stats.success).toFixed(1) : 0;
    const page2Rate = stats.success > 0 ? ((stats.page2Successes / stats.success) * 100).toFixed(1) : 0;
    const throughput = (stats.totalQueries / (testDuration / 1000)).toFixed(4);
    const avgDuration = stats.queryDurations.length > 0 
        ? (stats.queryDurations.reduce((a,b) => a+b, 0) / stats.queryDurations.length).toFixed(0) 
        : 0;
    
    // Analyze rate limit pattern
    const rateLimitAnalysis = analyzeRateLimitPattern(stats.blockIndices);
    
    const finalData = {
        timestamp: new Date().toISOString(),
        testDuration,
        config: CONFIG,
        stats: {
            totalQueries: stats.totalQueries,
            success: stats.success,
            blocked: stats.blocked,
            errors: stats.errors,
            successRate: parseFloat(successRate),
            blockRate: parseFloat(blockRate),
            consecutiveBlocks: stats.consecutiveBlocks,
            maxConsecutiveBlocks: stats.maxConsecutiveBlocks,
            blockIndices: stats.blockIndices,
            rollingWindowBlocks: stats.rollingWindowBlocks,
            hitHardLimit: stats.hitHardLimit,
            hitConsistentLimit: stats.hitConsistentLimit,
            firstBlockIndex: stats.firstBlockIndex,
            recoveryCount: stats.recoveryCount,
            throughput: parseFloat(throughput),
            avgQueryDuration: parseFloat(avgDuration),
            pageStats: {
                avgPage1: parseFloat(avgPage1),
                avgPage2: parseFloat(avgPage2),
                avgTotal: parseFloat(avgPage1) + parseFloat(avgPage2),
                page2SuccessRate: parseFloat(page2Rate)
            },
            relevance: {
                avgScore: parseFloat(avgRel),
                allScores: stats.relevanceScores,
                highCount: stats.relevanceScores.filter(s => s >= 70).length,
                lowCount: stats.relevanceScores.filter(s => s < 30).length
            },
            blockReasons: stats.blockReasons
        },
        rateLimitAnalysis,
        recommendations: []
    };
    
    // Generate recommendations
    if (stats.hitHardLimit) {
        finalData.recommendations.push({
            type: 'HARD_LIMIT_DETECTED',
            message: `Hard limit detected: ${stats.rollingWindowBlocks.length} blocks in rolling window of ${CONFIG.rollingWindowSize} queries`,
            threshold: `${CONFIG.hardLimitBlockThreshold} blocks in ${CONFIG.rollingWindowSize} queries`,
            recommendation: `0ms throttle is too aggressive. Use throttle >= 500ms`
        });
    } else if (stats.hitConsistentLimit) {
        finalData.recommendations.push({
            type: 'CONSISTENT_LIMIT_DETECTED',
            message: `Consistent blocking detected: ${stats.maxConsecutiveBlocks} consecutive blocks`,
            threshold: `${CONFIG.maxConsecutiveBlocks} consecutive blocks`,
            recommendation: `0ms throttle is too aggressive. Use throttle >= 1000ms`
        });
    } else if (rateLimitAnalysis.detected) {
        finalData.recommendations.push({
            type: 'RATE_LIMIT_PATTERN_DETECTED',
            message: rateLimitAnalysis.analysis,
            statistics: rateLimitAnalysis.statistics,
            recommendation: 'Pattern indicates rate limiting. Use throttle >= 750ms'
        });
    } else if (stats.blocked > 0) {
        finalData.recommendations.push({
            type: 'SPORADIC_BLOCKS_DETECTED',
            message: `Sporadic blocks detected: ${stats.blocked} blocks out of ${stats.totalQueries} queries`,
            blockRate: parseFloat(blockRate),
            analysis: rateLimitAnalysis.analysis,
            recommendation: '0ms throttle is borderline. Use throttle >= 500ms for safer operation'
        });
    } else {
        finalData.recommendations.push({
            type: 'NO_RATE_LIMIT_DETECTED',
            message: `No rate limiting detected even at 0ms throttle with ${CONFIG.workers} workers`,
            testedQueries: stats.totalQueries,
            successRate: parseFloat(successRate),
            throughput: parseFloat(throughput),
            recommendation: '0ms throttle is safe for production use (but monitor for degradation)'
        });
    }
    
    fs.writeFileSync(RESULTS_FILE, JSON.stringify(finalData, null, 2));
    
    log('\n' + '='.repeat(70));
    log('FINAL RESULTS');
    log('='.repeat(70));
    log(`Test Duration: ${(testDuration/1000).toFixed(2)}s`);
    log(`Total Queries: ${stats.totalQueries}`);
    log(`Success: ${stats.success} (${successRate}%)`);
    log(`Blocked: ${stats.blocked} (${blockRate}%)`);
    log(`Errors: ${stats.errors}`);
    log(`Consecutive Blocks: ${stats.consecutiveBlocks} | Max: ${stats.maxConsecutiveBlocks}`);
    log(`Throughput: ${throughput} queries/sec`);
    log(`Avg Query Duration: ${avgDuration}ms`);
    log(`Page Stats: Avg P1:${avgPage1} | Avg P2:${avgPage2} | Total:${parseFloat(avgPage1) + parseFloat(avgPage2)} | P2 Success:${page2Rate}%`);
    log(`Relevance: Avg ${avgRel}%`);
    log(`First Block: ${stats.firstBlockIndex > -1 ? stats.firstBlockIndex : 'N/A'} | Recoveries: ${stats.recoveryCount}`);
    log(`Status: ${stats.hitHardLimit ? '🚨 HARD LIMIT REACHED' : stats.hitConsistentLimit ? '⚠️ CONSISTENT LIMIT REACHED' : stats.blocked > 0 ? '⚠️ SPORADIC BLOCKS' : '✅ NO RATE LIMIT'}`);
    log('');
    log('Rate Limit Analysis:');
    log(`  Pattern: ${rateLimitAnalysis.pattern}`);
    log(`  Detected: ${rateLimitAnalysis.detected ? 'YES' : 'NO'}`);
    log(`  ${rateLimitAnalysis.analysis}`);
    if (rateLimitAnalysis.statistics) {
        log(`  Total Blocks: ${rateLimitAnalysis.statistics.totalBlocks}`);
        log(`  Avg Gap: ${rateLimitAnalysis.statistics.avgGap}`);
        log(`  Max Consecutive: ${rateLimitAnalysis.statistics.maxConsecutive}`);
        log(`  Clusters: ${rateLimitAnalysis.statistics.clusters}`);
        log(`  Max Cluster Size: ${rateLimitAnalysis.statistics.maxClusterSize}`);
    }
    log('');
    log('Block Reasons:');
    for (const [reason, count] of Object.entries(stats.blockReasons)) {
        log(`  ${reason}: ${count}`);
    }
    log('');
    log('Recommendations:');
    for (const rec of finalData.recommendations) {
        log(`  ${rec.type}: ${rec.message}`);
        if (rec.recommendation) log(`    → ${rec.recommendation}`);
    }
    log('');
    log(`Results: ${RESULTS_FILE}`);
    log(`Log: ${LOG_FILE}`);
    log('='.repeat(70) + '\n');
    
    return finalData;
}

// Run test
runAggressiveStressTest().then(() => {
    console.log('✅ Test complete!');
}).catch(error => {
    console.error('❌ Test failed:', error);
    process.exit(1);
});
