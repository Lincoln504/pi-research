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
 * IMPORTANT: The socket timeout must exceed the largest possible BrowserClient
 * request timeout (CLIENT_TIMEOUT_CAP_MS = 300s in browser-client.ts) so the
 * request-level timer — whose error text is classified by the retry gates —
 * always answers before the socket layer tears the connection down.
 */
const clientAgent = new http.Agent({
    keepAlive: true,
    maxSockets: 100, // Allow up to 100 concurrent requests to the leader
    maxFreeSockets: 10,
    // Above CLIENT_TIMEOUT_CAP_MS (300s) with margin — see the invariant above.
    timeout: 330000
});

/**
 * Get the global HTTP agent for client requests.
 * This is used by shutdownManager to properly destroy the agent on shutdown.
 */
export function getClientAgent(): http.Agent {
    return clientAgent;
}