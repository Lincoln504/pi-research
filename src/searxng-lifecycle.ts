/**
 * SearXNG Lifecycle Manager
 *
 * All agents (coordinator + researchers) share the same container.
 * Status states: 'starting_up' | 'active' | 'inactive' | 'error'
 *
 * Lifecycle: Container lives for the duration of the pi process.
 * No session-based shutdown - container persists across sessions.
 * Use shutdownLifecycle() only for manual cleanup or extension unload.
 */

import type { ExtensionContext } from '@mariozechner/pi-coding-agent';
import { DockerSearxngManager } from './infrastructure/searxng-manager.js';
import { logger } from './logger.js';
import * as path from 'node:path';

import * as fs from 'node:fs';
import * as os from 'node:os';

import { PROXY_URL } from './config.js';

// Extension directory for pi-research
const EXTENSION_DIR = path.join(
  process.env['HOME'] ?? os.homedir(),
  '.pi',
  'agent',
  'extensions',
  'pi-research',
);

// Singleton manager instance
let manager: DockerSearxngManager | null = null;
let sessionId: string | null = null;
let initialized = false;

/**
 * Get manager instance (for passing to web-research module)
 */
export function getManager(): DockerSearxngManager | null {
  return manager;
}

// Track status for TUI display (minimal: starting_up | active | inactive | error)
export type SearxngStatus = {
  state: 'starting_up' | 'active' | 'inactive' | 'error';
  connectionCount: number;
  url: string;
};

let currentStatus: SearxngStatus = {
  state: 'inactive',
  connectionCount: 0,
  url: '',
};

// Callbacks for status updates
type StatusCallback = (_status: SearxngStatus) => void;
let statusCallbacks: StatusCallback[] = [];

export function onStatusChange(callback: StatusCallback): () => void {
  statusCallbacks.push(callback);

  // Immediately call with current status
  callback(currentStatus);

  // Return unsubscribe function
  return () => {
    const index = statusCallbacks.indexOf(callback);
    if (index !== -1) {
      statusCallbacks.splice(index, 1);
    }
  };
}

function notifyStatusChange(): void {
  for (const callback of statusCallbacks) {
    callback(currentStatus);
  }
}

function extractSessionId(ctx: ExtensionContext): string {
  if ('sessionId' in ctx && typeof ctx.sessionId === 'string') {
    return ctx.sessionId;
  }
  // Fallback: generate unique ID
  return `pi-research-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Generate proxy-enabled SearXNG settings file dynamically
 * Uses configured PROXY_URL from config
 */
async function generateProxySettings(proxyUrl: string): Promise<string> {
  const defaultSettingsPath = path.join(EXTENSION_DIR, 'config', 'default-settings.yml');
  const proxySettingsPath = path.join(EXTENSION_DIR, 'config', 'proxy-settings-generated.yml');

  try {
    // Read default settings
    const defaultSettings = await fs.promises.readFile(defaultSettingsPath, 'utf-8');

    // Parse YAML to modify it
    const yaml = await import('js-yaml');
    const settings = yaml.load(defaultSettings) as any;

    // Add proxy configuration
    settings.outgoing = settings.outgoing || {};
    settings.outgoing.proxies = {
      'all://': [proxyUrl]
    };
    settings.outgoing.extra_proxy_timeout = 10;

    // Write generated settings
    await fs.promises.writeFile(proxySettingsPath, yaml.dump(settings), 'utf-8');

    logger.log(`[pi-research] Generated proxy settings: ${proxyUrl}`);

    return proxySettingsPath;
  } catch (error) {
    logger.error('[pi-research] Failed to generate proxy settings:', error);
    throw error;
  }
}

export async function initLifecycle(ctx: ExtensionContext): Promise<void> {
  if (initialized) {
    logger.log('[pi-research] SearXNG already initialized, skipping');
    return;
  }

  // Set state to starting_up
  currentStatus = {
    state: 'starting_up',
    connectionCount: 0,
    url: '',
  };
  notifyStatusChange();

  // Clean up old manager if exists
  if (manager !== null) {
    try {
      manager.stopHeartbeat();
      if (sessionId !== null) {
        await manager.release(sessionId).catch(() => {});
      }
    } catch (error) {
      logger.warn('[pi-research] Error cleaning up old manager:', error);
    }
  }

  // Configure proxy if PROXY_URL is set
  let settingsPath: string;
  if (PROXY_URL) {
    try {
      logger.log('[pi-research] Proxy configured, generating proxy settings...');
      settingsPath = await generateProxySettings(PROXY_URL);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error('[pi-research] Failed to configure proxy:', errorMsg);
      // Continue without proxy - user gets an error that explains the issue
      const proxyError = new Error(
        `Proxy configuration failed: ${errorMsg}\n\n` +
        `To fix:\n` +
        `1. Check that your proxy is running and accessible\n` +
        `2. Verify PROXY_URL format: socks5://host:port or http://host:port\n` +
        `3. Unset PROXY_URL to disable proxy`
      );
      proxyError.cause = error;
      throw proxyError;
    }
  } else {
    // Use default settings
    settingsPath = path.join(EXTENSION_DIR, 'config', 'default-settings.yml');
  }

  // Create new manager instance (singleton pattern - only one per extension lifecycle)
  manager = new DockerSearxngManager(EXTENSION_DIR, { settingsPath });
  manager.setContext(ctx);

  const ctxSessionId = extractSessionId(ctx);
  sessionId = ctxSessionId;

  try {
    await manager.acquire(ctxSessionId);
    manager.startHeartbeat();

    // Get current status
    const searxngStatus = await manager.getStatus();

    // Update internal status
    currentStatus = {
      state: 'active',
      connectionCount: 1, // Singleton always has 1 connection
      url: searxngStatus.url || '',
    };

    initialized = true;


    logger.log('[pi-research] SearXNG lifecycle initialized');
    logger.log('[pi-research] SearXNG container:', searxngStatus.url);

    notifyStatusChange();

  } catch (error) {
    logger.error('[pi-research] Failed to initialize SearXNG:', error);

    currentStatus = {
      state: 'error',
      connectionCount: 0,
      url: '',
    };

    initialized = true;
    notifyStatusChange();

    throw error;
  }
}

export async function ensureRunning(): Promise<string> {
  if (!manager) {
    throw new Error('SearXNG not initialized. Call initLifecycle() first.');
  }

  // ensureReady waits for container to be healthy
  await manager.ensureReady();

  return manager.getSearxngUrl();
}

export function getConnectionCount(): number {
  // Get actual active connection count from web-research module
  try {
    const { getActiveConnectionCount } = require('../web-research/utils.js');
    return getActiveConnectionCount();
  } catch {
    // Fallback: return 1 if active, 0 if not (singleton pattern)
    return currentStatus.state === 'active' ? 1 : 0;
  }
}

export function getStatus(): SearxngStatus {
  return { ...currentStatus };
}

export async function shutdownLifecycle(): Promise<void> {
  if (!manager || !initialized) {
    logger.log('[pi-research] SearXNG not active, skipping shutdown');
    return;
  }

  try {
    manager.stopHeartbeat();

    if (sessionId !== null) {
      await manager.release(sessionId);
    }

    currentStatus = {
      state: 'inactive',
      connectionCount: 0,
      url: '',
    };

    initialized = false;

    logger.log('[pi-research] SearXNG lifecycle shut down');
    notifyStatusChange();

  } catch (error) {
    logger.error('[pi-research] Error during shutdown:', error);
  } finally {
    manager = null;
    sessionId = null;
  }
}

export function isInitialized(): boolean {
  return initialized && manager !== null;
}
