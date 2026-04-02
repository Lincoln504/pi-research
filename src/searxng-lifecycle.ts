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
import { DockerSearxngManager } from '../../pi-search-scrape/searxng-manager.ts';
import { logger } from './logger.js';
import * as path from 'node:path';

import * as fs from 'node:fs';
import * as os from 'node:os';

import { ENABLE_TOR, TOR_SOCKS_PORT, TOR_CONTROL_PORT, TOR_AUTO_START } from './config.js';

import { initTorManager, shutdownTorManager } from './tor-manager.js';

// Extension directory for pi-research
const EXTENSION_DIR = path.join(
  process.env['HOME'] ?? os.homedir(),
  '.pi',
  'agent',
  'extensions',
  'pi-research',
);

// Singleton manager instance (exactly like pi-search-scrape)
let manager: DockerSearxngManager | null = null;
let sessionId: string | null = null;
let initialized = false;
let torManager: import('./tor-manager.js').TorManager | null = null;

/**
 * Get the manager instance (for passing to pi-search-scrape)
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
 * Generate Tor-enabled SearXNG settings file dynamically
 * Uses the configured Tor SOCKS port from config
 */
async function generateTorSettings(): Promise<string> {
  const defaultSettingsPath = path.join(EXTENSION_DIR, 'config', 'default-settings.yml');
  const torSettingsPath = path.join(EXTENSION_DIR, 'config', 'tor-settings-generated.yml');
  
  try {
    // Read default settings
    const defaultSettings = await fs.promises.readFile(defaultSettingsPath, 'utf-8');
    
    // Parse YAML to modify it
    const yaml = await import('js-yaml');
    const settings = yaml.load(defaultSettings) as any;
    
    // Add Tor proxy configuration
    settings.outgoing = settings.outgoing || {};
    settings.outgoing.proxies = {
      'all://': [`socks5://127.0.0.1:${TOR_SOCKS_PORT}`]
    };
    settings.outgoing.using_tor_proxy = true;
    settings.outgoing.extra_proxy_timeout = 10;
    
    // Write generated settings
    await fs.promises.writeFile(torSettingsPath, yaml.dump(settings), 'utf-8');
    
    logger.log(`[pi-research] Generated Tor settings with SOCKS port ${TOR_SOCKS_PORT}`);
    
    return torSettingsPath;
  } catch (error) {
    logger.error('[pi-research] Failed to generate Tor settings:', error);
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

  // Initialize Tor if enabled
  let settingsPath: string;
  if (ENABLE_TOR) {
    try {
      logger.log('[pi-research] Tor is enabled, initializing Tor...');
      torManager = await initTorManager({
        enabled: true,
        socksPort: TOR_SOCKS_PORT,
        controlPort: TOR_CONTROL_PORT,
        autoStart: TOR_AUTO_START,
      });
      
      const torInfo = torManager.getStatusInfo();
      logger.log(`[pi-research] Tor status: ${torInfo.status}`);
      if (torInfo.proxyUrl) {
        logger.log(`[pi-research] Using Tor proxy: ${torInfo.proxyUrl}`);
      }
      
      // Generate Tor-enabled settings file
      settingsPath = await generateTorSettings();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error('[pi-research] Tor initialization failed:', errorMsg);
      // Continue without Tor - user will get an error that explains the issue
      const torError = new Error(
        `Tor is enabled but failed to initialize: ${errorMsg}\n\n` +
        `To fix:\n` +
        `1. Install Tor: brew install tor (macOS) or apt install tor (Linux)\n` +
        `2. Set PI_RESEARCH_ENABLE_TOR=false to disable Tor\n` +
        `3. Set PI_RESEARCH_TOR_AUTO_START=true to auto-start Tor`
      );
      torError.cause = error;
  throw torError;
    }
  } else {
    // Use default settings
    settingsPath = path.join(EXTENSION_DIR, 'config', 'default-settings.yml');
  }

  // Clean up old manager if exists
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

    process.env['SEARXNG_EXTERNAL_MANAGED'] = 'true';

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
  // Singleton pattern: always 1 if active, 0 if not
  return currentStatus.state === 'active' ? 1 : 0;
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
    // Shutdown Tor if it was started by us
    if (torManager && TOR_AUTO_START) {
      await shutdownTorManager().catch((err) => {
        logger.warn('[pi-research] Error shutting down Tor:', err);
      });
    }
    manager = null;
    torManager = null;
    sessionId = null;
  }
}

export function isInitialized(): boolean {
  return initialized && manager !== null;
}
