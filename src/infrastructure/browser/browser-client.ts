/**
 * Browser Client for Remote Scheduler Communication
 *
 * HTTP client that communicates with a remote scheduler via HTTP.
 * Extracted from browser-manager.ts for better separation of concerns.
 */

import * as http from 'node:http';
import type { Config } from '../../config.ts';
import type { SearchResult } from '../../web-research/types.ts';
import type { IScheduler } from '../../core/interfaces/scheduler-interfaces.ts';
import { logger } from '../../logger.ts';
import { errorTracker } from '../../utils/error-tracker.ts';
import { getClientAgent } from './client-agent.ts';
import type { NodeError } from '../../types/index.ts';

/**
 * HTTP client that communicates with a remote scheduler.
 * Used when this process is not the leader.
 */
export class BrowserClient implements IScheduler {
    constructor(private readonly port: number) {
        logger.log(`[BrowserClient] Connecting to global scheduler at http://127.0.0.1:${port}`);
    }

    private async request<T>(path: string, data: any): Promise<T> {
        const start = Date.now();
        // Extract operation from path for error tracking
        const operation = path.includes('/search') ? 'search' :
                         path.includes('/scrape') ? 'browser-task' :
                         path.includes('/healthcheck') ? 'healthcheck' : 'network';

        return new Promise((resolve, reject) => {
            const agent = getClientAgent();
            // Increased timeout to 120s to allow for shared pool queuing delays
            const timeoutMs = 120000;
            let resolved = false;
            const controller = new AbortController();
            const timer = setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    controller.abort();
                    const error = new Error(`[BrowserClient] Request to ${path} timed out after ${timeoutMs}ms (Shared queue may be deep)`);
                    errorTracker.trackError(error, {
                        component: 'browser-manager',
                        operation,
                        errorType: 'timeout',
                    });
                    reject(error);
                }
            }, timeoutMs);

            const req = http.request({
                hostname: '127.0.0.1',
                port: this.port,
                path,
                method: 'POST',
                agent,
                signal: controller.signal,
                headers: { 'Content-Type': 'application/json' }
            }, (res) => {
                clearTimeout(timer);
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    if (resolved) return;
                    resolved = true;
                    const duration = Date.now() - start;
                    try {
                        const parsed = JSON.parse(body);
                        if (res.statusCode !== 200) {
                            const error = new Error(parsed.error || `HTTP ${res.statusCode}`);
                            errorTracker.trackError(error, {
                                component: 'browser-manager',
                                operation,
                                errorType: 'http_error',
                            });
                            reject(error);
                        } else {
                            logger.debug(`[BrowserClient] Request ${path} completed in ${duration}ms`);
                            resolve(parsed);
                        }
                    } catch (_e) {
                        const error = new Error(`Failed to parse response: ${body}`);
                        errorTracker.trackError(error, {
                            component: 'browser-manager',
                            operation,
                            errorType: 'parse_error',
                        });
                        reject(error);
                    }
                });
                res.on('error', (err) => {
                    if (resolved) return;
                    resolved = true;
                    clearTimeout(timer);
                    const error = new Error(`[BrowserClient] Response stream error on ${path}: ${err.message}`);
                    errorTracker.trackError(error, {
                        component: 'browser-manager',
                        operation,
                        errorType: 'response_stream_error',
                    });
                    reject(error);
                });
            });

            req.on('error', (err) => {
                if (resolved) return;
                resolved = true;
                clearTimeout(timer);
                // Enhance error message with socket-specific details
                const nodeErr = err as NodeError;
                let errorMsg: string;
                let errorType: string;
                if (nodeErr.code === 'ECONNRESET' || nodeErr.code === 'EPIPE') {
                    errorMsg = `Browser pool socket ${path} closed (pool likely busy or restarting) - ${err.message}`;
                    errorType = 'connection_reset';
                } else if (nodeErr.code === 'ECONNREFUSED') {
                    errorMsg = `Browser pool ${path} unreachable (server may have crashed) - ${err.message}`;
                    errorType = 'connection_refused';
                } else if (nodeErr.code === 'ETIMEDOUT') {
                    errorMsg = `Browser pool ${path} timed out (slow browser response) - ${err.message}`;
                    errorType = 'timeout';
                } else {
                    errorMsg = `Browser pool ${path} error: ${err.message}`;
                    errorType = 'unknown';
                }
                const error = new Error(errorMsg);
                logger.error(`[BrowserClient] Request to http://127.0.0.1:${this.port}${path} failed:`, errorMsg);
                errorTracker.trackError(error, {
                    component: 'browser-manager',
                    operation,
                    errorType,
                });
                reject(error);
            });
            req.write(JSON.stringify(data));
            req.end();
        });
    }

    async runSearch(query: string, _config?: Config): Promise<SearchResult[]> {
        return this.request('/search', { query });
    }

    async runScrape(url: string, _config?: Config): Promise<any> {
        return this.request('/scrape', { url });
    }

    async runHealthCheck(_config?: Config): Promise<{ success: boolean }> {
        return this.request('/healthcheck', {});
    }

    async shutdown() {
        // Clients don't shutdown the server
    }
}