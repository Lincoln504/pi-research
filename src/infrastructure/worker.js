import { ClusterWorker } from 'poolifier';
import { createRequire } from 'module';
import { executeSearchTask } from '../web-research/browser-core.ts';
import * as os from 'node:os';

// Lower process priority to remain responsive to OS (X11, etc)
try {
    os.setPriority(process.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
} catch (e) {
    // Ignore if priority setting is not supported or permitted
}

const require = createRequire(import.meta.url);

/**
 * Main Task Handler for Cluster Worker
 * 
 * DESIGN CHANGE: Every search now launches a FRESH Camoufox instance.
 * This rotates TLS fingerprints, socket states, and browser contexts.
 * Prevents DuckDuckGo from linking multiple searches to a single session.
 */
async function runTask(data) {
    const { type, query } = data;
    const startTime = Date.now();
    
    let browser = null;
    try {
        const { Camoufox } = require('camoufox-js');
        
        if (type === 'search') {
            // Launch fresh browser
            browser = await Camoufox({
                headless: true,
                humanize: true,
            });

            const results = await executeSearchTask(browser, query);
            
            // Close immediately to rotate session
            await browser.close();
            browser = null;

            return {
                results,
                duration: Date.now() - startTime,
                workerId: process.pid 
            };
        }
        
        return { error: 'Unknown task type' };
    } catch (error) {
        if (browser) await browser.close().catch(() => {});
        return { 
            error: error instanceof Error ? error.message : String(error),
            duration: Date.now() - startTime
        };
    }
}

export default new ClusterWorker(runTask, {
    maxInactiveTime: 60000
});
