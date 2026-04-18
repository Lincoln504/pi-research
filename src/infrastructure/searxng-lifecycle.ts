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
 * Cleanup is triggered via pi lifecycle hooks rather than process signal ownership.
 * Use shutdownLifecycle() for extension-owned cleanup paths.
 */

import type { ExtensionContext } from '@mariozechner/pi-coding-agent';
import {
  DOCKER_HOST_INTERNAL_HOSTNAME,
  DockerSearxngManager,
  type SearxngManagerConfig,
  verifyDockerInstalled,
} from './searxng-manager.ts';
import { logger, type ILogger } from '../logger.ts';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { PROXY_URL, BRAVE_SEARCH_API_KEY } from '../config.ts';
import { shutdownManager } from '../utils/shutdown-manager.ts';

/**
 * Extension directory for pi-research
 */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function hasExtensionAssets(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, 'config', 'searxng', 'default-settings.yml')) &&
    fs.existsSync(path.join(dir, 'config', 'searxng', 'limiter.toml'))
  );
}

function resolveExtensionDir(): string {
  const envOverride = process.env['PI_RESEARCH_EXTENSION_DIR']?.trim();
  if (envOverride && hasExtensionAssets(envOverride)) {
    return envOverride;
  }

  const installedDir = path.join(
    os.homedir(),
    '.pi',
    'agent',
    'extensions',
    'pi-research',
  );
  if (hasExtensionAssets(installedDir)) {
    return installedDir;
  }

  const repoDir = path.resolve(__dirname, '..', '..');
  if (hasExtensionAssets(repoDir)) {
    return repoDir;
  }

  return installedDir;
}

const EXTENSION_DIR = resolveExtensionDir();
const LOCALHOST_PROXY_HOST_PATTERN = /^([a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?)(localhost|127\.0\.0\.1)(?=[:/?#]|$)/i;

export function rewriteLocalhostProxyForContainer(proxyUrl: string): string {
  return proxyUrl.replace(
    LOCALHOST_PROXY_HOST_PATTERN,
    `$1${DOCKER_HOST_INTERNAL_HOSTNAME}`,
  );
}

/**
 * Track status for TUI display (minimal: starting_up | active | inactive | error)
 */
export type SearxngLifecycleStatus = {
  state: 'starting_up' | 'active' | 'inactive' | 'error';
  url: string;
  isFunctional: boolean;
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
  braveApiKey?: string;
}

type ResolvedConfig = {
  extensionDir: string;
  logger: ILogger;
  manager: DockerSearxngManager | null;
  proxyUrl: string | undefined;
  braveApiKey: string | undefined;
};

/**
 * Manager interface for dependency injection
 */
export interface ISearxngLifecycleManager {
  init(ctx: ExtensionContext): Promise<void>;
  ensureRunning(): Promise<string>;
  getManager(): DockerSearxngManager | null;
  getStatus(): SearxngLifecycleStatus;
  setFunctional(ok: boolean): void;
  isFunctional(): boolean;
  onStatusChange(callback: StatusCallback): () => void;
  shutdown(): Promise<void>;
  isInitialized(): boolean;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: ResolvedConfig = {
  extensionDir: EXTENSION_DIR,
  logger,
  manager: null,
  proxyUrl: PROXY_URL,
  braveApiKey: BRAVE_SEARCH_API_KEY,
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
    url: '',
    isFunctional: false,
  };
  private statusCallbacks: StatusCallback[] = [];
  private readonly config: ResolvedConfig;
  private proxySettingsPath: string | null = null;

  constructor(config: Partial<SearxngLifecycleConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config } as ResolvedConfig;
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

  setFunctional(ok: boolean): void {
    this.currentStatus.isFunctional = ok;
    this.notifyStatusChange();
  }

  isFunctional(): boolean {
    return this.currentStatus.isFunctional;
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
   * Generate a runtime settings file with optional proxy and/or Brave Search API key injected.
   * Localhost proxy addresses are rewritten to Docker's host alias automatically.
   */
  private async generateRuntimeSettings(proxyUrl?: string, braveApiKey?: string): Promise<string> {
    const defaultSettingsPath = path.join(
      this.config.extensionDir,
      'config',
      'default-settings.yml'
    );
    const uniqueId = this.sessionId?.substring(0, 8) || Math.random().toString(36).substring(2, 8);
    const runtimeSettingsPath = path.join(
      this.config.extensionDir,
      'config',
      `runtime-settings-${uniqueId}.yml`
    );

    try {
      const defaultSettings = await fs.promises.readFile(defaultSettingsPath, 'utf-8');
      const yaml = await import('js-yaml');
      const settings = yaml.load(defaultSettings) as any;

      if (proxyUrl) {
        const containerProxyUrl = rewriteLocalhostProxyForContainer(proxyUrl);
        if (containerProxyUrl !== proxyUrl) {
          logger.log(`[pi-research] Converting localhost proxy to Docker host alias: ${proxyUrl} -> ${containerProxyUrl}`);
        }
        settings.outgoing = settings.outgoing || {};
        settings.outgoing.proxies = { 'all://': [containerProxyUrl] };
        settings.outgoing.extra_proxy_timeout = 10;
        logger.log(`[pi-research] Runtime settings: proxy configured (${containerProxyUrl})`);
      }

      if (braveApiKey) {
        settings.engines = settings.engines || [];
        settings.engines.push({
          name: 'braveapi',
          engine: 'braveapi',
          api_key: braveApiKey,
          shortcut: 'bapi',
          weight: 1.2,
          inactive: false,
        });
        logger.log('[pi-research] Runtime settings: braveapi engine enabled');
      }

      await fs.promises.writeFile(runtimeSettingsPath, yaml.dump(settings), 'utf-8');
      this.proxySettingsPath = runtimeSettingsPath;

      return runtimeSettingsPath;
    } catch (error) {
      logger.error('[pi-research] Failed to generate runtime settings:', error);
      throw error;
    }
  }

  async init(ctx: ExtensionContext): Promise<void> {
    if (this.initialized) {
      logger.log('[pi-research] SearXNG already initialized, skipping');
      return;
    }

    // Skip real Docker verification when a test/dummy manager is injected.
    if (!this.config.manager) {
      const dockerCheck = await verifyDockerInstalled();
      if (!dockerCheck.running) {
        this.currentStatus = {
          state: 'error',
          url: '',
          isFunctional: false,
        };
        this.notifyStatusChange();
        const errorMsg = `Docker health check failed: ${dockerCheck.error}`;
        logger.error(`[pi-research] ${errorMsg}`);
        throw new Error(errorMsg);
      }
    }

    // Set state to starting_up
    this.currentStatus = {
      state: 'starting_up',
      url: '',
      isFunctional: false,
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

      // Generate runtime settings if proxy or Brave API key is configured
      let settingsPath: string;
      if (this.config.proxyUrl || this.config.braveApiKey) {
        try {
          if (this.config.proxyUrl) logger.log('[pi-research] Proxy configured, generating runtime settings...');
          if (this.config.braveApiKey) logger.log('[pi-research] BRAVE_SEARCH_API_KEY set, enabling braveapi engine...');
          settingsPath = await this.generateRuntimeSettings(this.config.proxyUrl, this.config.braveApiKey);
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          logger.error('[pi-research] Failed to generate runtime settings:', errorMsg);
          const configError = new Error(
            `Runtime settings generation failed: ${errorMsg}\n\n` +
            `To fix:\n` +
            `1. Check PROXY_URL format: socks5://host:port or http://host:port\n` +
            `2. Check BRAVE_SEARCH_API_KEY is a valid key\n` +
            `3. Unset these env vars to use default settings`
          );
          configError.cause = error;
          throw configError;
        }
      } else {
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
        url: searxngStatus.url || '',
        isFunctional: false, // Reset on every re-init, must re-verify
      };

      this.initialized = true;

      logger.log('[pi-research] SearXNG lifecycle initialized');
      logger.log('[pi-research] SearXNG container:', searxngStatus.url);

      this.notifyStatusChange();

    } catch (error) {
      logger.error('[pi-research] Failed to initialize SearXNG:', error);

      this.currentStatus = {
        state: 'error',
        url: '',
        isFunctional: false,
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

      // Cleanup temporary proxy settings file if it exists
      if (this.proxySettingsPath && fs.existsSync(this.proxySettingsPath)) {
        try {
          await fs.promises.unlink(this.proxySettingsPath);
          logger.log(`[pi-research] Deleted temporary proxy settings: ${this.proxySettingsPath}`);
        } catch (error) {
          logger.warn('[pi-research] Failed to delete temporary proxy settings:', error);
        }
        this.proxySettingsPath = null;
      }

      this.currentStatus = {
        state: 'inactive',
        url: '',
        isFunctional: false,
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
  // Register extension-owned cleanup once; repeated initLifecycle() calls are safe.
  shutdownManager.register(shutdownLifecycle);
}

/**
 * Backward compatible: Ensure container is running
 */
export async function ensureRunning(): Promise<string> {
  return getLifecycleManager().ensureRunning();
}

/**
 * Backward compatible: Get status (renamed type to avoid conflict)
 */
export function getStatus(): SearxngLifecycleStatus {
  return getLifecycleManager().getStatus();
}

/**
 * Backward compatible: Set functional state
 */
export function setFunctional(ok: boolean): void {
  getLifecycleManager().setFunctional(ok);
}

/**
 * Backward compatible: Get functional state
 */
export function isFunctional(): boolean {
  return getLifecycleManager().isFunctional();
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

/**
 * Check if Docker is installed and running
 */
export async function checkDockerAvailability(): Promise<{ installed: boolean; running: boolean; error?: string }> {
  return verifyDockerInstalled();
}

// Export original type for compatibility
export type SearxngStatus = SearxngLifecycleStatus;
