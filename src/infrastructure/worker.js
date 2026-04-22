import { ClusterWorker } from 'poolifier';
import { createRequire } from 'module';
import { executeSearchTask } from '../web-research/browser-core.ts';

const require = createRequire(import.meta.url);

let browserInstance = null;

/**
 * Worker-level Browser Launcher (Singleton per process)
 */
async function getBrowser() {
    if (browserInstance && browserInstance.isConnected()) return browserInstance;
    
    const { Camoufox } = require('camoufox-js');
    browserInstance = await Camoufox({
        headless: true,
        humanize: true,
    });
    return browserInstance;
}

/**
 * Main Task Handler for Cluster Worker
 */
async function runTask(data) {
    const { type, query } = data;
    const startTime = Date.now();
    
    try {
        const browser = await getBrowser();
        
        if (type === 'search') {
            const results = await executeSearchTask(browser, query);
            return {
                results,
                duration: Date.now() - startTime,
                workerId: process.pid // Process ID in cluster mode
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

export default new ClusterWorker(runTask, {
    maxInactiveTime: 60000
});
