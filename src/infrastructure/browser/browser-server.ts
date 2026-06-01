import * as http from 'node:http';
import { logger } from '../../logger.ts';
import type { SearchResult } from '../../web-research/types.ts';

export interface BrowserServerOptions {
    onSearch: (query: string) => Promise<SearchResult[]>;
    onScrape: (url: string) => Promise<any>;
    onHealthCheck: () => Promise<{ success: boolean }>;
}

export class BrowserServer {
    private server: http.Server | null = null;
    private port: number = 0;

    constructor(private options: BrowserServerOptions) {}

    async start(): Promise<number> {
        return new Promise((resolve, reject) => {
            this.server = http.createServer(async (req, res) => {
                if (req.method !== 'POST') {
                    res.writeHead(405);
                    res.end('Method Not Allowed');
                    return;
                }

                let body = '';
                const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB limit

                req.on('data', chunk => { 
                    body += chunk; 
                    if (body.length > MAX_BODY_SIZE) {
                        req.destroy(new Error('Payload too large'));
                    }
                });

                req.on('error', (err) => {
                    logger.error('[BrowserServer] Request stream error:', err);
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
                        logger.error('[BrowserServer] Error handling request:', error);
                        res.writeHead(500);
                        // lgtm[js/stack-trace-exposure] — localhost-only IPC server; clients are trusted local processes
                        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
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
