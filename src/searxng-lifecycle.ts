/**
 * SearXNG Lifecycle Manager
 *
 * Refactored to use dependency injection for testability.
 * Maintains backward compatibility with original API.
 *
 * All agents (coordinator + researchers) share same container.
 * Status states: 'starting_up' | 'active' | 'inactive' | 'error'
 *
 * Lifecycle: Container lives for duration of pi process.
 * No session-based shutdown - container persists across sessions.
 * Use shutdownLifecycle() only for manual cleanup or extension unload.
 */

import type { ExtensionContext } from '@mariozechner/pi-coding-agent';
import { DockerSearxngManager, type SearxngManagerConfig } from './infrastructure/searxng-manager.js';
import { logger, type ILogger } from './logger.js';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { PROXY_URL } from './config.js';

/**
 * Extension directory for pi-research
 */
const EXTENSION_DIR = path.join(
  process.env['HOME'] ?? os.homedir(),
  '.pi',
  'agent',
  'extensions',
  'pi-research',
);

/**
 * Track status for TUI display (minimal: starting_up | active | inactive | error)
 */
export type SearxngLifecycleStatus = {
  state: 'starting_up' | 'active' | 'inactive' | 'error';
  connectionCount: number;
  url: string;
};

/**
 * Status callback type
 */
type StatusCallback = (_status: SearxngLifecycleStatus) => void;

/**
 * Searxng Lifecycle Manager Configuration
 */
export interface SearxngLifecycleConfig {
  extensionDir?: string;
  logger?: ILogger;
  manager?: DockerSearxngManager | null;
  proxyUrl?: string;
  getActiveConnectionCount?: () => number;
}

/**
 * Manager interface for dependency injection
 */
export interface ISearxngLifecycleManager {
  init(ctx: ExtensionContext): Promise<void>;
  ensureRunning(): Promise<string>;
  getManager(): DockerSearxngManager | null;
  getConnectionCount(): number;
  getStatus(): SearxngLifecycleStatus;
  onStatusChange(callback: StatusCallback): () => void;
  shutdown(): Promise<void>;
  isInitialized(): boolean;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: Required<SearxngLifecycleConfig> = {
  extensionDir: EXTENSION_DIR,
  logger,
  manager: null,
  proxyUrl: PROXY_URL,
  getActiveConnectionCount: undefined,
};

/**
 * Searxng Lifecycle Manager Class
 *
 * Manages the lifecycle of the SearXNG container.
 * Uses dependency injection for testability.
 */
export class SearxngLifecycleManager implements ISearxngLifecycleManager {
  private manager: DockerSearxngManager | null = null;
  private sessionId: string | null = null;
  private initialized = false;
  private currentStatus: SearxngLifecycleStatus = {
    state: 'inactive',
    connectionCount: 0,
    url: '',
  };
  private statusCallbacks: StatusCallback[] = [];
  private readonly config: Required<SearxngLifecycleConfig>;

  constructor(config: Partial<SearxngLifecycleConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    // Set manager immediately if provided (for testing)
    if (this.config.manager) {
      this.manager = this.config.manager;
    }
  }

  /**
   * Get manager instance (for passing to web-research module)
   */
  getManager(): DockerSearxngManager | null {
    return this.manager;
  }

  /**
   * Subscribe to status changes
   */
  onStatusChange(callback: StatusCallback): () => void {
    this.statusCallbacks.push(callback);
    // Immediately call with current status (handle errors gracefully)
    try {
      callback(this.currentStatus);
    } catch (error) {
      // Log errors but don't fail registration
      this.config.logger.error('[searxng-lifecycle] Error in status callback:', error);
    }
    // Return unsubscribe function
    return () => {
      const index = this.statusCallbacks.indexOf(callback);
      if (index !== -1) {
        this.statusCallbacks.splice(index, 1);
      }
    };
  }

  private notifyStatusChange(): void {
    for (const callback of this.statusCallbacks) {
      try {
        callback(this.currentStatus);
      } catch (error) {
        // Log errors but don't fail the entire notification
        this.config.logger.error('[searxng-lifecycle] Error in status callback:', error);
      }
    }
  }

  private extractSessionId(ctx: ExtensionContext): string {
    if ('sessionId' in ctx && typeof ctx.sessionId === 'string') {
      return ctx.sessionId;
    }
    // Fallback: generate unique ID
    return `pi-research-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * Generate proxy-enabled SearXNG settings file dynamically
   * Uses configured PROXY_URL from config
   *
   * Automatically converts localhost (127.0.0.1) to Docker gateway IP (172.19.0.1)
   * because containers cannot access host's 127.0.0.1 directly.
   */
  private async generateProxySettings(proxyUrl: string): Promise<string> {
    const defaultSettingsPath = path.join(
      this.config.extensionDir,
      'config',
      'default-settings.yml'
    );
    const proxySettingsPath = path.join(
      this.config.extensionDir,
      'config',
      'proxy-settings-generated.yml'
    );

    try {
      // Read default settings
      const defaultSettings = await fs.promises.readFile(defaultSettingsPath, 'utf-8');

      // Parse YAML to modify it
      const yaml = await import('js-yaml');
      const settings = yaml.load(defaultSettings) as any;

      // Convert localhost addresses for Docker container access
      // When user specifies socks5://127.0.0.1:9050, container cannot reach host's 127.0.0.1
      // Instead, use Docker gateway IP (172.19.0.1) which can reach host
      let containerProxyUrl = proxyUrl;
      if (proxyUrl.includes('127.0.0.1') || proxyUrl.includes('localhost')) {
        containerProxyUrl = proxyUrl.replace(/127\.0\.0\.1|localhost/g, '172.19.0.1');
        logger.log(`[pi-research] Converting localhost proxy to Docker gateway: ${proxyUrl} → ${containerProxyUrl}`);
      }

      // Add proxy configuration
      settings.outgoing = settings.outgoing || {};
      settings.outgoing.proxies = {
        'all://': [containerProxyUrl]
      };
      settings.outgoing.extra_proxy_timeout = 10;

      // Write generated settings
      await fs.promises.writeFile(proxySettingsPath, yaml.dump(settings), 'utf-8');

      logger.log(`[pi-research] Generated proxy settings for container: ${containerProxyUrl}`);

      return proxySettingsPath;
    } catch (error) {
      logger.error('[pi-research] Failed to generate proxy settings:', error);
      throw error;
    }
  }

  async init(ctx: ExtensionContext): Promise<void> {
    if (this.initialized) {
      logger.log('[pi-research] SearXNG already initialized, skipping');
      return;
    }

    // Set state to starting_up
    this.currentStatus = {
      state: 'starting_up',
      connectionCount: 0,
      url: '',
    };
    this.notifyStatusChange();

    // Use injected manager or create new one
    if (this.config.manager) {
      this.manager = this.config.manager;
    } else {
      // Clean up old manager if exists
      if (this.manager !== null) {
        try {
          this.manager.stopHeartbeat();
          if (this.sessionId !== null) {
            await this.manager.release(this.sessionId).catch(() => {});
          }
        } catch (error) {
          this.config.logger.warn('[pi-research] Error cleaning up old manager:', error);
        }
      }

      // Configure proxy if PROXY_URL is set
      let settingsPath: string;
      if (this.config.proxyUrl) {
        try {
          logger.log('[pi-research] Proxy configured, generating proxy settings...');
          settingsPath = await this.generateProxySettings(this.config.proxyUrl);
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
        settingsPath = path.join(
          this.config.extensionDir,
          'config',
          'default-settings.yml'
        );
      }

      // Create new manager instance
      const managerConfig: SearxngManagerConfig = { settingsPath };
      this.manager = new DockerSearxngManager(this.config.extensionDir, managerConfig);
    }

    this.manager.setContext(ctx);

    const ctxSessionId = this.extractSessionId(ctx);
    this.sessionId = ctxSessionId;

    try {
      await this.manager.acquire(ctxSessionId);
      this.manager.startHeartbeat();

      // Get current status
      const searxngStatus = await this.manager.getStatus();

      // Update internal status
      this.currentStatus = {
        state: 'active',
        connectionCount: 1, // Singleton always has 1 connection
        url: searxngStatus.url || '',
      };

      this.initialized = true;

      logger.log('[pi-research] SearXNG lifecycle initialized');
      logger.log('[pi-research] SearXNG container:', searxngStatus.url);

      this.notifyStatusChange();

    } catch (error) {
      logger.error('[pi-research] Failed to initialize SearXNG:', error);

      this.currentStatus = {
        state: 'error',
        connectionCount: 0,
        url: '',
      };

      this.initialized = true;
      this.notifyStatusChange();

      throw error;
    }
  }

  async ensureRunning(): Promise<string> {
    if (!this.manager) {
      throw new Error('SearXNG not initialized. Call initLifecycle() first.');
    }

    // ensureReady waits for container to be healthy
    await this.manager.ensureReady();

    return this.manager.getSearxngUrl();
  }

  getConnectionCount(): number {
    // Use injected callback or fallback to web-research module
    if (this.config.getActiveConnectionCount) {
      return this.config.getActiveConnectionCount();
    }

    // Get actual active connection count from web-research module
    try {
      const { getActiveConnectionCount } = require('../web-research/utils.js');
      return getActiveConnectionCount();
    } catch {
      // Fallback: return 1 if active, 0 if not (singleton pattern)
      return this.currentStatus.state === 'active' ? 1 : 0;
    }
  }

  getStatus(): SearxngLifecycleStatus {
    return { ...this.currentStatus };
  }

  async shutdown(): Promise<void> {
    if (!this.manager || !this.initialized) {
      logger.log('[pi-research] SearXNG not active, skipping shutdown');
      return;
    }

    try {
      this.manager.stopHeartbeat();

      if (this.sessionId !== null) {
        await this.manager.release(this.sessionId);
      }

      this.currentStatus = {
        state: 'inactive',
        connectionCount: 0,
        url: '',
      };

      this.initialized = false;

      logger.log('[pi-research] SearXNG lifecycle shut down');
      this.notifyStatusChange();

    } catch (error) {
      logger.error('[pi-research] Error during shutdown:', error);
    } finally {
      this.manager = null;
      this.sessionId = null;
    }
  }

  isInitialized(): boolean {
    return this.initialized && this.manager !== null;
  }
}

// ============================================================================
// GLOBAL STATE FOR BACKWARD COMPATIBILITY
// ============================================================================

let globalManager: SearxngLifecycleManager | null = null;

/**
 * Create a new lifecycle manager instance
 */
export function createSearxngLifecycleManager(
  config: Partial<SearxngLifecycleConfig> = {}
): SearxngLifecycleManager {
  return new SearxngLifecycleManager(config);
}

/**
 * Get the global lifecycle manager instance
 */
export function getLifecycleManager(): SearxngLifecycleManager {
  if (!globalManager) {
    globalManager = new SearxngLifecycleManager();
  }
  return globalManager;
}

/**
 * Set the global lifecycle manager instance (for testing)
 */
export function setLifecycleManager(manager: SearxngLifecycleManager | null): void {
  globalManager = manager;
}

/**
 * Reset the global lifecycle manager instance (for testing)
 */
export function resetLifecycleManager(): void {
  globalManager = null;
}

// ============================================================================
// BACKWARD COMPATIBILITY EXPORTS
// ============================================================================

/**
 * Backward compatible: Get manager instance
 */
export function getManager(): DockerSearxngManager | null {
  return getLifecycleManager().getManager();
}

/**
 * Backward compatible: Initialize lifecycle
 */
export async function initLifecycle(ctx: ExtensionContext): Promise<void> {
  await getLifecycleManager().init(ctx);
}

/**
 * Backward compatible: Ensure container is running
 */
export async function ensureRunning(): Promise<string> {
  return getLifecycleManager().ensureRunning();
}

/**
 * Backward compatible: Get connection count
 */
export function getConnectionCount(): number {
  return getLifecycleManager().getConnectionCount();
}

/**
 * Backward compatible: Get status (renamed type to avoid conflict)
 */
export function getStatus(): SearxngLifecycleStatus {
  return getLifecycleManager().getStatus();
}

/**
 * Backward compatible: Subscribe to status changes
 */
export function onStatusChange(callback: StatusCallback): () => void {
  return getLifecycleManager().onStatusChange(callback);
}

/**
 * Backward compatible: Shutdown lifecycle
 */
export async function shutdownLifecycle(): Promise<void> {
  await getLifecycleManager().shutdown();
}

/**
 * Backward compatible: Check if initialized
 */
export function isInitialized(): boolean {
  return getLifecycleManager().isInitialized();
}

// Export original type for compatibility
export type SearxngStatus = SearxngLifecycleStatus;
