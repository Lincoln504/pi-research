/**
 * SearXNG Lifecycle Manager
 *
 * Manages DockerSearxngManager as singleton (like pi-search-scrape).
 * All agents (coordinator + researchers) share the same container.
 * Status states: 'starting_up' | 'active' | 'inactive' | 'error'
 *
 * Lifecycle: Container lives for the duration of the pi process.
 * No session-based shutdown - container persists across sessions.
 * Use shutdownLifecycle() only for manual cleanup or extension unload.
 */

import type { ExtensionContext } from '@mariozechner/pi-coding-agent';
import { DockerSearxngManager } from '../../pi-search-scrape/searxng-manager.ts';
import * as path from 'node:path';
import * as os from 'node:os';

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

export async function initLifecycle(ctx: ExtensionContext): Promise<void> {
  if (initialized) {
    console.log('[pi-research] SearXNG already initialized, skipping');
    return;
  }

  // Set state to starting_up
  currentStatus = {
    state: 'starting_up',
    connectionCount: 0,
    url: '',
  };
  notifyStatusChange();

  // Let TUI finish rendering before startup logs appear
  await new Promise<void>(resolve => setTimeout(resolve, 100));

  // Clean up old manager if exists
  if (manager !== null) {
    try {
      manager.stopHeartbeat();
      if (sessionId !== null) {
        await manager.release(sessionId).catch(() => {});
      }
    } catch (error) {
      console.warn('[pi-research] Error cleaning up old manager:', error);
    }
  }

  // Create new manager instance (singleton pattern - only one per extension lifecycle)
  manager = new DockerSearxngManager(EXTENSION_DIR, {});
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
    
    console.log('[pi-research] SearXNG lifecycle initialized');
    console.log('[pi-research] SearXNG container:', searxngStatus.url);
    
    notifyStatusChange();
    
  } catch (error) {
    console.error('[pi-research] Failed to initialize SearXNG:', error);
    
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
    console.log('[pi-research] SearXNG not active, skipping shutdown');
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
    
    console.log('[pi-research] SearXNG lifecycle shut down');
    notifyStatusChange();
    
  } catch (error) {
    console.error('[pi-research] Error during shutdown:', error);
  } finally {
    manager = null;
    sessionId = null;
  }
}

export function isInitialized(): boolean {
  return initialized && manager !== null;
}
