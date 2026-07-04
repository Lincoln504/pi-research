import * as http from 'node:http';
import * as crypto from 'node:crypto';
import { logger } from '../../logger.ts';
import type { SearchResult } from '../../web-research/types.ts';
import { isCloudflareBlockError, isPoolShutdownError } from './browser-error-utils.ts';

export interface BrowserServerOptions {
    onSearch: (query: string) => Promise<SearchResult[]>;
    onScrape: (url: string) => Promise<any>;
    onHealthCheck: () => Promise<{ success: boolean }>;
}

/**
 * FIX (#21): Shared secret for authenticating local HTTP requests.
 * Generated once per server instance; clients must present it in the
 * `X-Browser-Auth` header. This prevents unauthorized local processes
 * from issuing search/scrape requests through the browser pool.
 */
let _authSecret: string | null = null;

function getOrCreateAuthSecret(): string {
  if (!_authSecret) {
    _authSecret = crypto.randomBytes(32).toString('hex');
  }
  return _authSecret;
}

export function getBrowserServerAuthSecret(): string {
  return getOrCreateAuthSecret();
}

export class BrowserServer {
    private server: http.Server | null = null;
    private port: number = 0;

    constructor(private options: BrowserServerOptions) {}

    async start(): Promise<number> {
        return new Promise((resolve, reject) => {
            this.server = http.createServer(async (req, res) => {
                // FIX (#21): Validate auth token on every request
                const rawAuth = req.headers['x-browser-auth'];
                const authHeader = Array.isArray(rawAuth) ? rawAuth[0] : rawAuth;
                const expected = Buffer.from(getOrCreateAuthSecret(), 'utf8');
                const actual = Buffer.from(authHeader ?? '', 'utf8');
                if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
                    res.writeHead(403, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Unauthorized' }));
                    return;
                }

                if (req.method !== 'POST') {
                    res.writeHead(405);
                    res.end('Method Not Allowed');
                    return;
                }

                let body = '';
                let oversized = false;
                const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB limit

                req.on('data', chunk => {
                    body += chunk;
                    if (body.length > MAX_BODY_SIZE) {
                        oversized = true;
                        req.destroy(new Error('Payload too large'));
                    }
                });

                req.on('error', (err) => {
                    logger.error('[BrowserServer] Request stream error:', err);
                    // req.destroy() on oversize emits 'error', not 'end', so no response
                    // would otherwise be sent. Reply 413 best-effort before the socket
                    // tears down so the client gets a clear status, not a bare reset.
                    if (oversized && !res.headersSent) {
                        try {
                            res.writeHead(413, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'Payload too large' }));
                        } catch { /* socket may already be gone */ }
                    }
                });

                req.on('end', async () => {
                    try {
                        const data = JSON.parse(body);
                        let result: any;

                        switch (req.url) {
                            case '/search':
                                result = await this.options.onSearch(data.query);
                                break;
                            case '/scrape':
                                result = await this.options.onScrape(data.url);
                                break;
                            case '/healthcheck':
                                result = await this.options.onHealthCheck();
                                break;
                            default:
                                res.writeHead(404);
                                res.end('Not Found');
                                return;
                        }

                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify(result));
                    } catch (error) {
                        // A Cloudflare/bot challenge is an EXPECTED scrape outcome, not a
                        // server fault — log it at WARN so it doesn't inflate ERROR counts.
                        // Everything else is a genuine request-handling error.
                        if (isCloudflareBlockError(error)) {
                            logger.warn('[BrowserServer] Request blocked by bot protection:', error instanceof Error ? error.message : String(error));
                        } else if (isPoolShutdownError(error)) {
                            // Pool destroyed mid-request during quit/SIGTERM teardown — expected,
                            // not a server fault. DEBUG so a normal shutdown doesn't emit ERRORs.
                            logger.debug('[BrowserServer] Request abandoned during shutdown:', error instanceof Error ? error.message : String(error));
                        } else {
                            logger.error('[BrowserServer] Error handling request:', error);
                        }

                        // Extract safe error message - first line only to prevent stack trace exposure
                        let errorMessage = 'Unknown error';
                        if (error instanceof Error && error.message) {
                            errorMessage = (error.message.split('\n')[0] || '').trim();
                        } else if (typeof error === 'string') {
                            errorMessage = (error.split('\n')[0] || '').trim();
                        }

                        // Headers may already be out (e.g. res.end() threw mid-response) —
                        // writeHead() would then throw ERR_HTTP_HEADERS_SENT inside this async
                        // handler and surface as an unhandledRejection in the leader process.
                        if (!res.headersSent) {
                            res.writeHead(500, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: errorMessage }));
                        } else {
                            res.destroy();
                        }
                    }
                });
            });

            this.server.listen(0, '127.0.0.1', () => {
                const addr = this.server?.address();
                if (addr && typeof addr === 'object') {
                    this.port = addr.port;
                    logger.log(`[BrowserServer] Listening on http://127.0.0.1:${this.port}`);
                    resolve(this.port);
                } else {
                    reject(new Error('Failed to get server port'));
                }
            });

            this.server.on('error', (err) => {
                logger.error('[BrowserServer] Server error:', err);
                reject(err);
            });
        });
    }

    async stop(): Promise<void> {
        if (this.server) {
            this.server.closeAllConnections?.();
            return new Promise((resolve) => {
                this.server?.close(() => {
                    this.server = null;
                    resolve();
                });
            });
        }
    }

    getPort(): number {
        return this.port;
    }
}
