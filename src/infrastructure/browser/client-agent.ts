/**
 * HTTP Client Agent for Browser Pool Communication
 *
 * Global HTTP Agent for high-concurrency client requests.
 * Extracted from browser-manager.ts for better separation of concerns.
 */

import * as http from 'node:http';

/**
 * Global HTTP Agent for high-concurrency client requests
 *
 * IMPORTANT: The socket timeout must be longer than the BrowserClient request timeout (60s,
 * REQUEST_TIMEOUT_MS in browser-client.ts) to prevent premature socket closure when the
 * browser is slow or the queue is deep.
 */
const clientAgent = new http.Agent({
    keepAlive: true,
    maxSockets: 100, // Allow up to 100 concurrent requests to the leader
    maxFreeSockets: 10,
    // 180s (3x the client timeout) to handle slow browser responses
    // and prevent "socket hang up" errors during peak load
    timeout: 180000
});

/**
 * Get the global HTTP agent for client requests.
 * This is used by shutdownManager to properly destroy the agent on shutdown.
 */
export function getClientAgent(): http.Agent {
    return clientAgent;
}