/**
 * SearXNG Container Manager - Simplified Design
 *
 * Singleton-style SearXNG container management shared by research sessions.
 *
 * DESIGN PRINCIPLES:
 * 1. Shared container reuse across research sessions
 * 2. Lazy startup on first use
 * 3. Explicit extension-owned cleanup when the extension shuts down
 * 4. Simple error recovery - if container is gone, recreate it
 * 5. No AutoRemove - manage cleanup explicitly
 * 6. No complex reuse logic - just check for container by name
 * 7. Manage Docker images - pull latest, prune old images on start
 */

import Docker from 'dockerode';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { StateManager } from './state-manager.ts';
import { logger } from '../logger.ts';

// Docker type definitions
interface DockerContainerInspectInfo {
  State: {
    Running: boolean;
    Status: string;
  };
  NetworkSettings: {
    Ports: Record<string, Array<{ HostPort: string }> | null> | null;
  };
}

interface DockerContainerListInfo {
  Id: string;
  Names: string[];
  Image: string;
  State: string;
  Status: string;
  RepoTags?: string[];
}

interface DockerImageInfo {
  Id: string;
  RepoTags?: string[];
  Created: number;
}

interface DockerContainerCreateOptions {
  name: string;
  Image: string;
  ExposedPorts: Record<string, {}>;
  HostConfig: {
    PortBindings: Record<string, Array<{ HostPort: string }>>;
    Binds: string[];
    AutoRemove: boolean;
    ExtraHosts?: string[];
  };
  Env: string[];
  Labels: Record<string, string>;
}

export const DOCKER_HOST_INTERNAL_HOSTNAME = 'host.docker.internal';

// Extension context type
interface ExtensionContext {
  ui?: {
    notify(_message: string, _type?: 'info' | 'warning' | 'error'): void;
  };
}

// Default configuration
const DEFAULT_CONFIG = {
  port: 55732,
  imageName: 'searxng/searxng',
  imageTag: 'latest',
  healthTimeout: 120000,
  pruneOldImages: true,
  containerName: 'pi-searxng',
} as const;

/**
 * Configuration from environment variables
 */
interface EnvConfig {
  port?: number;
  imageName?: string;
  imageTag?: string;
  healthTimeout?: number;
  containerName?: string;
}

type DockerConnectionOptions = ConstructorParameters<typeof Docker>[0];

function toDockerBindPath(p: string): string {
  return process.platform === 'win32' ? p.replace(/\\/g, '/') : p;
}

function normalizeSocketPath(socketPath: string): string {
  const trimmed = socketPath.trim();
  if (trimmed.startsWith('\\\\.\\pipe\\')) {
    return `//./pipe/${trimmed.slice('\\\\.\\pipe\\'.length)}`;
  }
  return trimmed;
}

function parseDockerHost(host: string): DockerConnectionOptions {
  if (host.startsWith('unix://')) {
    return { socketPath: host.slice('unix://'.length) };
  }

  if (host.startsWith('npipe://')) {
    return { socketPath: normalizeSocketPath(host.slice('npipe://'.length)) };
  }

  const url = new URL(host);
  const protocol = url.protocol.replace(':', '');
  return {
    host: url.hostname,
    port: url.port ? parseInt(url.port, 10) : undefined,
    protocol: protocol === 'https' ? 'https' : protocol === 'ssh' ? 'ssh' : 'http',
  };
}

export function getDockerConnectionCandidates(
  env: NodeJS.ProcessEnv = process.env,
): DockerConnectionOptions[] {
  const candidates: DockerConnectionOptions[] = [];
  const socketOverride = env['DOCKER_SOCKET']?.trim();
  if (socketOverride) {
    candidates.push({ socketPath: normalizeSocketPath(socketOverride) });
  }

  const hostOverride = env['DOCKER_HOST']?.trim();
  if (hostOverride) {
    try {
      candidates.push(parseDockerHost(hostOverride));
    } catch {
      // Ignore malformed DOCKER_HOST and fall through to platform defaults.
    }
  }

  if (process.platform === 'win32') {
    candidates.push(
      { socketPath: '//./pipe/docker_engine' },
      { socketPath: '//./pipe/dockerDesktopLinuxEngine' },
      { socketPath: '//./pipe/dockerDesktopWindowsEngine' },
    );
  } else {
    candidates.push({ socketPath: '/var/run/docker.sock' });
  }

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = JSON.stringify(candidate);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function getDockerHostGatewayExtraHosts(platform: NodeJS.Platform = process.platform): string[] {
  return platform === 'linux' ? [`${DOCKER_HOST_INTERNAL_HOSTNAME}:host-gateway`] : [];
}

/**
 * Load configuration from environment variables
 */
function loadConfigFromEnv(): EnvConfig {
  const config: EnvConfig = {};

  const healthTimeoutEnv = process.env['PI_RESEARCH_HEALTH_CHECK_TIMEOUT_MS'];
  if (healthTimeoutEnv !== undefined) {
    const parsed = parseInt(healthTimeoutEnv, 10);
    if (!isNaN(parsed)) {
      config.healthTimeout = parsed;
    }
  }

  const imageTagEnv = process.env['SEARXNG_IMAGE_TAG']?.trim();
  if (imageTagEnv) {
    config.imageTag = imageTagEnv;
  }

  return config;
}

/**
 * Sleep for ms milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Check if a TCP port is accepting connections
 */
function isPortListening(port: number, host: string = '127.0.0.1'): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket: net.Socket = new net.Socket();

    socket.setTimeout(2000); // 2 second timeout

    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });

    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });

    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });

    socket.connect(port, host);
  });
}

/**
 * Check if SearXNG HTTP endpoint is responding (not just TCP port open)
 * This ensures the Python/Flask server is actually ready to serve requests.
 */
async function isSearxngHttpReady(port: number, host: string = '127.0.0.1'): Promise<boolean> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`http://${host}:${port}/search?q=test&format=json`, {
      method: 'GET',
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    });
    return response.ok || response.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * SearxngManagerConfig type
 */
export interface SearxngManagerConfig {
  port?: number;
  settingsPath?: string; // Custom settings file path (for Tor mode)
  imageName?: string;
  imageTag?: string;
  healthTimeout?: number;
  pruneOldImages?: boolean;
  containerName?: string;
  stateDir?: string;
}

/**
 * SearxngContainerInfo type
 */
export interface SearxngContainerInfo {
  id: string;
  name: string;
  port: number;
  url: string;
}

/**
 * SearxngStatus type
 */
export interface SearxngStatus {
  dockerAvailable: boolean;
  healthy: boolean;
  containerId?: string;
  containerName?: string;
  port?: number;
  url?: string;
  error?: string;
}

/**
 * DockerSearxngManager Class
 *
 * Simplified SearXNG Docker container manager.
 * Session-scoped lifecycle with deterministic container naming.
 * Also manages Docker images (pulls latest, prunes old images).
 */
/**
 * Verify Docker is installed and daemon is responsive
 */
export async function verifyDockerInstalled(): Promise<{ installed: boolean; running: boolean; error?: string }> {
  let lastError = 'Docker daemon is not running. Please start Docker.';

  for (const candidate of getDockerConnectionCandidates()) {
    try {
      const docker = new Docker(candidate);
      await docker.ping();
      return { installed: true, running: true };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  if (
    lastError.includes('ENOENT') ||
    lastError.includes('ECONNREFUSED') ||
    lastError.includes('The system cannot find the file specified') ||
    lastError.includes('EACCES') ||
    lastError.includes('permission')
  ) {
    let errorMsg = 'Docker daemon is not running or inaccessible.';
    if (process.platform === 'linux') {
      errorMsg += ' On Linux, run: sudo systemctl start docker && sudo usermod -aG docker $USER. Then log out and back in.';
    } else if (process.platform === 'darwin') {
      errorMsg += ' Start Docker Desktop from Applications.';
    } else if (process.platform === 'win32') {
      errorMsg += ' Start Docker Desktop from the Start menu.';
    }
    return { installed: true, running: false, error: errorMsg };
  }

  return { installed: false, running: false, error: `Docker not found or inaccessible: ${lastError}` };
}

export class DockerSearxngManager {
  private readonly docker: Docker | null = null;
  private container: Docker.Container | null = null;
  private containerInfo: SearxngContainerInfo | null = null;
  private readonly config: Required<SearxngManagerConfig>;
  private ctx: ExtensionContext | null = null;
  private sessionId: string | null = null;
  private starting: Promise<void> | null = null;
  private readonly stateManager: StateManager;
  private readonly _extensionDir: string;
  private readonly _settingsPath: string;
  private containerStartupLock: Promise<void> | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private heartbeatRunning = false;

  constructor(
    _extensionDir: string,
    config: SearxngManagerConfig = {},
    options?: { docker?: Docker },
  ) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...loadConfigFromEnv(),
      ...config,
    } as Required<SearxngManagerConfig>;
    this._extensionDir = _extensionDir;
    this._settingsPath = config.settingsPath || path.join(_extensionDir, 'config', 'searxng', 'default-settings.yml');
    // Initialize Docker client
    try {
      this.docker = options?.docker || new Docker(getDockerConnectionCandidates()[0]);
    } catch (error) {
      logger.warn('[SearXNG Manager] Failed to initialize Docker client:', error);
      this.docker = null;
    }

    // Initialize StateManager for singleton mode
    this.stateManager = new StateManager(config.stateDir);
    // Cleanup is orchestrated by the extension lifecycle hook in index.ts, not by process signals here.
  }

  /**
   * Set extension context for UI notifications
   */
  setContext(ctx: ExtensionContext): void {
    this.ctx = ctx;
  }

  /**
   * Notify user via UI
   */
  private notify(message: string, type: 'info' | 'success' | 'warning' | 'error' = 'info'): void {
    if (this.ctx?.ui) {
      // Convert 'success' to 'info' for UI compatibility
      const uiType: 'info' | 'warning' | 'error' = type === 'success' ? 'info' : type;
      this.ctx.ui.notify(message, uiType);
    } else {
      logger.log(`[SearXNG Manager ${type.toUpperCase()}] ${message}`);
    }
  }

  /**
   * Get StateManager instance
   */
  getStateManager(): StateManager | null {
    return this.stateManager;
  }

  /**
   * Check if heartbeat is running
   */
  isHeartbeatRunning(): boolean {
    return this.heartbeatRunning;
  }

  /**
   * Cleanup stale sessions — removes sessions whose process is dead OR that haven't
   * been seen in over 2 hours.  Uses StateManager's built-in cleanup which checks
   * both the timeout threshold AND process liveness (so crashed processes are
   * removed immediately without waiting for the timeout to expire).
   */
  async cleanupStaleSessions(): Promise<void> {

    try {
      const removed = await this.stateManager.cleanupStaleSessions(2 * 60 * 60 * 1000); // 2 hours
      if (removed > 0) {
        logger.log(`[SearXNG Manager] Cleaned up ${removed} stale session(s)`);
      }
    } catch (error) {
      logger.error('[SearXNG Manager] Error cleaning up stale sessions:', error);
    }
  }

  /**
   * Verify container health
   */
  async verifyContainerHealthy(): Promise<boolean> {
    if (!this.container || this.docker === null) {
      return false;
    }

    try {
      const info: DockerContainerInspectInfo = await this.container.inspect() as DockerContainerInspectInfo;
      const portListening = await isPortListening(this.config.port);
      return info.State.Running && portListening;
    } catch {
      return false;
    }
  }

  /**
   * Start heartbeat monitoring
   */
  startHeartbeat(): void {
    if (this.heartbeatRunning) {
      logger.warn('[SearXNG Manager] Heartbeat already running');
      return;
    }

    this.heartbeatRunning = true;
    const baseInterval = 30000; // 30 seconds
    const jitter = Math.floor(Math.random() * 5000); // 0-5 seconds random
    const interval = baseInterval + jitter;

    logger.log(`[SearXNG Manager] Heartbeat interval: ${interval}ms (${baseInterval}ms base + ${jitter}ms jitter)`);

    this.heartbeatInterval = setInterval(() => {
      void (async (): Promise<void> => {
        try {
          // Refresh this session's lastSeen so it isn't pruned by cleanupStaleSessions
          if (this.sessionId !== null) {
            this.stateManager.updateHeartbeat(this.sessionId).catch(() => {});
          }
          // Remove sessions whose pi processes have died since the last cycle
          await this.cleanupStaleSessions();
          await this.verifyContainerHealthy();
        } catch (error) {
          logger.error('[SearXNG Manager] Heartbeat check failed:', error);
        }
      })();
    }, interval).unref(); // Don't keep event loop alive when nothing else is running

    logger.log('[SearXNG Manager] Heartbeat started');
  }

  /**
   * Stop heartbeat monitoring
   */
  stopHeartbeat(): void {
    this.heartbeatRunning = false;

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    logger.log('[SearXNG Manager] Heartbeat stopped');
  }

  /**
   * Acquire container for session (singleton mode)
   */
  async acquire(sessionId: string): Promise<void> {

    if (this.containerStartupLock) {
      await this.containerStartupLock;
    }

    const existingSession = await this.stateManager.getSession(sessionId);
    if (existingSession) {
      logger.log(`[SearXNG Manager] Session ${sessionId} already has container reference`);
      await this.stateManager.updateActivity(sessionId);
      this.sessionId = sessionId;
      // If this manager instance has no container reference (e.g. after a session
      // reconnect where pi reuses the same session ID), attach to the running container
      // so ensureReady() and getStatus() work correctly.
      if (!this.container) {
        try {
          const existing = await this.findContainerByName(this.config.containerName);
          if (existing) {
            const info: DockerContainerInspectInfo = await existing.inspect() as DockerContainerInspectInfo;
            this.container = existing;

            const portBindings = info.NetworkSettings.Ports?.['8080/tcp'];
            let port = this.config.port;
            if (portBindings && portBindings.length > 0) {
              const hostPort = portBindings[0]?.HostPort;
              if (hostPort) {
                port = parseInt(hostPort, 10);
              }
            }

            this.containerInfo = {
              id: existing.id,
              name: this.config.containerName,
              port,
              url: `http://localhost:${port}`,
            };
            this.config.port = port;
          }
        } catch (err) {
          logger.warn('[SearXNG Manager] Could not attach to existing container on reconnect:', err);
        }
      }
      return;
    }

    this.containerStartupLock = (async (): Promise<void> => {
      try {
        const containerName = this.config.containerName;
        logger.log(`[SearXNG Manager] Acquiring container for session ${sessionId}`);

        const existingContainer = await this.findContainerByName(containerName);

        if (existingContainer) {
          logger.log(`[SearXNG Manager] Reusing existing singleton container: ${containerName}`);

          const info: DockerContainerInspectInfo = await existingContainer.inspect() as DockerContainerInspectInfo;
          this.container = existingContainer;

          let port = this.config.port;
          const portBindings = info.NetworkSettings.Ports?.['8080/tcp'];
          if (portBindings && portBindings.length > 0) {
            const hostPort = portBindings[0]?.HostPort;
            if (hostPort) {
              port = parseInt(hostPort, 10);
            }
          }

          this.containerInfo = {
            id: existingContainer.id,
            name: containerName,
            port,
            url: `http://localhost:${port}`,
          };

          this.config.port = port;

          if (!info.State.Running) {
            await this.startContainer(existingContainer);
            await this.waitForHealthy();
          } else {
            const healthy = await this.verifyContainerHealthy();
            if (!healthy) {
              await this.waitForHealthy();
            }
          }
        } else {
          await this.startSingleton();
        }

        await this.stateManager.addSession(sessionId, containerName);
        this.sessionId = sessionId;
        logger.log(`[SearXNG Manager] Session ${sessionId} acquired container reference`);

      } finally {
        this.containerStartupLock = null;
      }
    })();

    await this.containerStartupLock;
  }

  /**
   * Release container for session (singleton mode)
   */
  async release(sessionId: string): Promise<void> {

    logger.log(`[SearXNG Manager] Releasing container for session ${sessionId}`);

    await this.stateManager.removeSession(sessionId);

    // Clean up sessions whose processes have died before counting remaining references.
    // Without this, stale sessions from crashed/killed terminals accumulate in the state
    // file and prevent the container from stopping even when no real sessions remain.
    await this.cleanupStaleSessions();

    const remainingSessions = await this.stateManager.getAllSessions();
    if (Object.keys(remainingSessions).length === 0) {
      logger.log('[SearXNG Manager] No more sessions, stopping singleton container');
      await this.stopSingleton();
    } else {
      logger.log(`[SearXNG Manager] Container still in use by ${Object.keys(remainingSessions).length} session(s)`);
    }
  }

  /**
   * Start singleton container
   */
  private async startSingleton(): Promise<void> {
    const containerName = this.config.containerName;

    logger.log(`[SearXNG Manager] Starting singleton container: ${containerName}`);

    await this.ensureImage();

    try {
      const containerResult = await this.createContainer(containerName, this.config.port);
      this.container = containerResult.container;
      const assignedPort = containerResult.assignedPort;

      await this.startContainer(this.container);

      this.containerInfo = {
        id: this.container.id,
        name: containerName,
        port: assignedPort,
        url: `http://localhost:${assignedPort}`,
      };

      this.config.port = assignedPort;

      await this.waitForHealthy();

      logger.log(`[SearXNG Manager] Singleton container started on port ${assignedPort}`);
    } catch (error) {
      logger.error('[SearXNG Manager] Failed to start singleton container:', error);
      throw error;
    }
  }

  /**
   * Stop singleton container
   */
  private async stopSingleton(): Promise<void> {
    logger.log('[SearXNG Manager] Stopping singleton container');

    if (this.heartbeatInterval) {
      this.stopHeartbeat();
    }

    if (this.container) {
      try {
        await this.stopContainer(this.container);
        await this.removeContainer(this.container);
        logger.log('[SearXNG Manager] Singleton container stopped');
      } catch (error) {
        logger.warn('[SearXNG Manager] Error stopping singleton container:', error);
      } finally {
        this.container = null;
        this.containerInfo = null;
      }
    }
  }

  /**
   * Check if Docker is available
   */
  private async checkDocker(): Promise<boolean> {
    if (!this.docker) {
      return false;
    }

    try {
      await this.docker.ping();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get full image name with tag
   */
  private getFullImageName(): string {
    return `${this.config.imageName}:${this.config.imageTag}`;
  }

  /**
   * Check if Docker image exists locally
   */
  private async imageExists(): Promise<boolean> {
    if (!this.docker) {
      return false;
    }

    try {
      const fullImage = this.getFullImageName();
      const image = this.docker.getImage(fullImage);
      await image.inspect();
      return true;
    } catch {
      // Image doesn't exist
      return false;
    }
  }

  /**
   * Pull the latest Docker image
   */
  private async pullLatestImage(): Promise<void> {
    if (this.docker === null) {
      throw new Error('Docker not available.');
    }

    const fullImage = this.getFullImageName();

    this.notify(`Updating SearXNG image: ${fullImage}...`, 'info');
    this.notify('This may take 1-2 minutes on first run.', 'warning');

    try {
      const docker = this.docker;
      await new Promise<void>((resolve, reject) => {
        void docker.pull(fullImage, (err: Error | null, stream: NodeJS.ReadableStream) => {
          if (err) {
            reject(err);
            return;
          }

          docker.modem.followProgress(stream, (err: Error | null) => {
            if (err) {
              reject(err);
            } else {
              resolve();
            }
          }, (event: Record<string, unknown>) => {
            // Optional: log progress events
            if (event['status'] === 'Pulling fs layer' || event['status'] === 'Downloading') {
              // Could show progress here
            }
          });
        });
      });

      this.notify('SearXNG image updated successfully.', 'success');
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to pull image: ${errMsg}`, { cause: error });
    }
  }

  /**
   * Prune old SearXNG images (dangling and non-latest tags)
   */
  private async pruneOldImages(): Promise<void> {
    if (!this.docker) {
      return;
    }

    if (!this.config.pruneOldImages) {
      return;
    }

    try {
      this.notify('Cleaning up old SearXNG images...', 'info');

      // Get all images for the repository
      const images: DockerImageInfo[] = await this.docker.listImages({ filters: { reference: [this.config.imageName] } });

      const currentImage = this.getFullImageName();

      for (const image of images) {
        const repoTags = image.RepoTags;
        if (repoTags && repoTags.length > 0) {
          for (const tag of repoTags) {
            // Skip the current image (latest)
            if (tag === currentImage) {
              continue;
            }

            // Remove old images
            const img = this.docker.getImage(tag);
            try {
              await img.remove({ force: false });
              this.notify(`Removed old image: ${tag}`, 'info');
            } catch (error) {
              // Image might be in use, that's okay
              logger.warn('[SearXNG Manager] Could not remove image:', tag, error);
            }
          }
        }
      }

      // Also prune dangling images
      await this.docker.pruneImages({ filters: { dangling: ['true'] } });

      this.notify('Image cleanup complete.', 'success');
    } catch (error) {
      logger.warn('[SearXNG Manager] Error pruning old images:', error);
      // Don't fail the whole process if pruning fails
    }
  }

  /**
   * Ensure image is available and up-to-date
   */
  private async ensureImage(): Promise<void> {
    const imageExists = await this.imageExists();

    if (!imageExists) {
      // Image doesn't exist, pull it
      await this.pullLatestImage();
    } else {
      // Image exists, prune old ones and optionally pull latest
      await this.pruneOldImages();

      // Optionally: always pull latest to stay up-to-date
      // Uncomment the next line to always update on start:
      // await this.pullLatestImage();
    }
  }

  /**
   * Find container by name
   */
  private async findContainerByName(name: string): Promise<Docker.Container | null> {
    if (!this.docker) {
      return null;
    }

    try {
      const containers: DockerContainerListInfo[] = await this.docker.listContainers({ all: true });

      for (const c of containers) {
        if (c.Names.some((n: string) => n === `/${name}`)) {
          return this.docker.getContainer(c.Id);
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Create a new container with port auto-assignment
   */
  private async createContainer(
    name: string,
    preferredPort: number | null,
  ): Promise<{ container: Docker.Container; assignedPort: number }> {
    if (!this.docker) {
      throw new Error('Docker not available.');
    }

    const fullImage = this.getFullImageName();

    // Mount both settings.yml and limiter.toml for complete bot detection disable
    const settingsPath = this._settingsPath;
    const limiterConfigPath = path.join(this._extensionDir, 'config', 'searxng', 'limiter.toml');

    // Verify configuration files exist
    if (!fs.existsSync(settingsPath)) {
      throw new Error(`Settings file not found: ${settingsPath}.`);
    }
    if (!fs.existsSync(limiterConfigPath)) {
      throw new Error(`Limiter config not found: ${limiterConfigPath}. Please ensure limiter.toml exists.`);
    }

    // Try preferred port first, or use auto-assignment (empty string)
    const hostPort = preferredPort ? preferredPort.toString() : '';

    const containerConfig: DockerContainerCreateOptions = {
      name,
      Image: fullImage,
      ExposedPorts: { '8080/tcp': {} },
      HostConfig: {
        PortBindings: {
          '8080/tcp': [{ HostPort: hostPort }],
        },
        Binds: [
          `${toDockerBindPath(settingsPath)}:/etc/searxng/settings.yml:ro`,
          `${toDockerBindPath(limiterConfigPath)}:/etc/searxng/limiter.toml:ro`,
        ],
        AutoRemove: false,
        ExtraHosts: getDockerHostGatewayExtraHosts(),
      },
      Env: [
        // No SEARXNG_LIMITER or SEARXNG_BIND_ADDRESS - use mounted config files only
      ],
      Labels: {
        'managed-by': 'pi-research',
        'mode': 'singleton',
      },
    };

    const container = await this.docker.createContainer(containerConfig);

    // Query the actual assigned port (important for auto-assignment)
    const info: DockerContainerInspectInfo = await container.inspect() as DockerContainerInspectInfo;
    const portBindings = info.NetworkSettings.Ports?.['8080/tcp'];
    const assignedPort = (portBindings && portBindings.length > 0 && portBindings[0]?.HostPort)
      ? parseInt(portBindings[0].HostPort, 10)
      : (preferredPort ?? 0);

    logger.log(`[SearXNG Manager] Container created with port ${assignedPort}`);

    return { container, assignedPort };
  }

  /**
   * Start a container
   */
  private async startContainer(container: Docker.Container): Promise<void> {
    await container.start();
  }

  /**
   * Stop a container
   */
  private async stopContainer(container: Docker.Container): Promise<void> {
    try {
      await container.stop({ t: 10 });
    } catch (error: unknown) {
      // Container might already be stopped (error 304)
      const errorStr = String(error);
      if (errorStr.includes('is not running') ||
          errorStr.includes('container already stopped') ||
          errorStr.includes('304')) {
        // Already stopped, that's fine
        return;
      }
      logger.warn('[SearXNG Manager] Error stopping container:', error);
    }
  }

  /**
   * Remove a container
   */
  private async removeContainer(container: Docker.Container): Promise<void> {
    await Promise.race([
      container.remove({ v: true, force: true }),
      new Promise<void>((_, reject) => {
        setTimeout(() => {
          reject(new Error('container.remove timed out after 15s'));
        }, 15000);
      }),
    ]).catch((err: unknown) => {
      if (!String(err).includes('No such container')) {
        logger.warn('[SearXNG Manager] Error removing container:', err);
      }
    });
  }

  /**
   * Wait for container to be healthy
   */
  private async waitForHealthy(): Promise<void> {
    if (!this.container) {
      throw new Error('No container to wait for.');
    }

    const startTime = Date.now();
    const timeout = this.config.healthTimeout;
    const checkInterval = 3000; // Check every 3 seconds
    const STARTUP_DELAY = 5000; // Wait 5 seconds for initial startup

    this.notify('Starting SearXNG container and waiting for it to be ready...', 'info');
    this.notify('If this is your first run, it may take 1-2 minutes to download the image.', 'warning');
    this.notify('Subsequent runs will be much faster.', 'info');

    // Wait for container to start (initial delay)
    await sleep(STARTUP_DELAY);

    let consecutiveHealthyChecks = 0;
    const HEALTHY_CHECKS_NEEDED = 2; // Need 2 consecutive healthy checks
    let lastElapsedTime = '';

    while (Date.now() - startTime < timeout) {
      try {
        // Check if container still exists and get its state in one call
        let info: DockerContainerInspectInfo;
        try {
          info = await this.container.inspect() as DockerContainerInspectInfo;
        } catch (error: unknown) {
          const err = error as { statusCode?: number };
          if (err.statusCode === 404) {
            // Container was removed, recreate it
            this.notify('Container was removed, recreating...', 'warning');
            const goneError = new Error('CONTAINER_GONE');
            goneError.cause = error;
            throw goneError;
          }
          throw error;
        }

        // Check if container is still running
        if (!info.State.Running) {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);

          // Container has exited, get logs to understand why
          try {
            const logs = await this.container.logs({ stdout: true, stderr: true, tail: 50 });
            const logsStr = logs.toString();

            this.notify(`Container exited with status: ${info.State.Status} (${elapsed}s elapsed)`, 'error');
            logger.error('[SearXNG Manager] Container logs:', logsStr);

            // Check for common error patterns
            if (logsStr.includes('bind') && (logsStr.includes('address already in use') || logsStr.includes('already allocated'))) {
              throw new Error(`Failed to start container: Port ${this.config.port} is already in use. Check if another SearXNG container or service is using this port.`, { cause: logsStr });
            }

            // Generic error with logs
            throw new Error(`Container exited unexpectedly. Last 50 lines of logs:\n${logsStr}`, { cause: logsStr });
          } catch (error: unknown) {
            if (error instanceof Error) {
              throw error; // Re-throw our custom error
            }
            // If log retrieval failed, throw a generic error
            throw new Error(`Container exited with status: ${info.State.Status}. Unable to retrieve logs.`, { cause: error });
          }
        }

        // Enhanced health check: container running AND HTTP endpoint is responding
        // First do a fast TCP check, then verify HTTP server is actually ready
        const portListening = await isPortListening(this.config.port);
        if (portListening) {
          // Port is open, check if HTTP server is ready
          const httpReady = await isSearxngHttpReady(this.config.port);
          if (httpReady) {
            consecutiveHealthyChecks++;
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
            if (consecutiveHealthyChecks >= HEALTHY_CHECKS_NEEDED) {
              this.notify(`SearXNG container is ready! (${elapsed}s elapsed)`, 'success');
              return;
            } else if (lastElapsedTime !== elapsed) {
              this.notify(`SearXNG container starting up... (${elapsed}s elapsed)`, 'info');
              lastElapsedTime = elapsed;
            }
          } else {
            // Port is listening but HTTP not ready yet (Python/Flask still initializing)
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
            if (lastElapsedTime !== elapsed) {
              this.notify(`SearXNG container running, HTTP server initializing... (${elapsed}s elapsed)`, 'info');
              lastElapsedTime = elapsed;
            }
            consecutiveHealthyChecks = 0; // Reset counter since HTTP failed
          }
        } else {
          // Container is running but port not listening yet
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
          if (lastElapsedTime !== elapsed) {
            this.notify(`SearXNG container running, waiting for port ${this.config.port} to be ready... (${elapsed}s elapsed)`, 'info');
            lastElapsedTime = elapsed;
          }
          consecutiveHealthyChecks = 0; // Reset counter since port failed
        }

        await sleep(checkInterval);
      } catch (error: unknown) {
        // If container is gone, rethrow to trigger recreation
        if (error instanceof Error && error['message'] === 'CONTAINER_GONE') {
          throw error;
        }
        // Log other errors but continue
        logger.error('[SearXNG Manager] Health check error:', error);
        await sleep(checkInterval);
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const containerId = this.container.id;
    throw new Error(`Container did not become healthy within ${elapsed}s. Check Docker logs with: docker logs ${containerId}`);
  }

  /**
   * Start SearXNG for a session
   */
  async start(sessionId: string): Promise<void> {
    this.sessionId = sessionId;

    const dockerAvailable = await this.checkDocker();

    if (!dockerAvailable) {
      this.notify('Docker is not available. SearXNG search functionality will not work.', 'error');
      throw new Error('Docker not available');
    }

    logger.log('[SearXNG Manager] Starting in singleton mode');

    await this.cleanupStaleSessions();
    await this.acquire(sessionId);
    this.startHeartbeat();
  }

  /**
   * Stop SearXNG container
   */
  async stop(): Promise<void> {
    if (this.sessionId) {
      logger.log(`[SearXNG Manager] Releasing container for session ${this.sessionId}`);
      await this.release(this.sessionId);
      this.sessionId = null;
      this.starting = null;
    }
  }

  /**
   * Get current status
   */
  async getStatus(): Promise<SearxngStatus> {
    const dockerAvailable = await this.checkDocker();

    if (!dockerAvailable) {
      return {
        dockerAvailable: false,
        healthy: false,
      };
    }

    if (this.container && this.containerInfo) {
      try {
        const info: DockerContainerInspectInfo = await this.container.inspect() as DockerContainerInspectInfo;

        // Enhanced health check: container running AND port is listening
        // SearXNG bot detection blocks HTTP requests, so we use TCP check instead
        const portListening = await isPortListening(this.config.port);
        const healthy = info.State.Running && portListening;

        return {
          containerId: this.container.id,
          containerName: this.containerInfo.name,
          port: this.containerInfo.port,
          url: this.containerInfo.url,
          healthy,
          dockerAvailable: true,
        };
      } catch (error) {
        return {
          dockerAvailable: true,
          healthy: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    return {
      dockerAvailable: true,
      healthy: false,
    };
  }

  /**
   * Get SearXNG URL
   */
  getSearxngUrl(): string {
    if (this.containerInfo) {
      return this.containerInfo.url;
    }

    throw new Error('SearXNG container not running.');
  }

  /**
   * Ensure container is ready before use
   */
  async ensureReady(): Promise<void> {
    if (!this.container || !this.containerInfo) {
      throw new Error('SearXNG container not initialized. Call acquire() first.');
    }

    // If a start is already in progress, wait for it
    if (this.starting) {
      await this.starting;
      return;
    }

    // Check if container is healthy
    const status = await this.getStatus();
    if (!status.healthy) {
      // Directly stop/remove/restart the container rather than going through start() →
      // acquire(). acquire() early-returns when the session already exists in state, so
      // calling start() here would leave the unhealthy container in place.
      this.starting = (async (): Promise<void> => {
        try {
          if (this.container) {
            try {
              await this.stopContainer(this.container);
            } catch { /* ignore — may already be stopped */ }
            try {
              await this.removeContainer(this.container);
            } catch { /* ignore — may already be gone */ }
            this.container = null;
            this.containerInfo = null;
          }
          await this.startSingleton();
        } finally {
          this.starting = null;
        }
      })();

      try {
        await this.starting;
      } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error);
        throw new Error(`SearXNG container is not healthy and restart failed: ${errMsg}`, { cause: error });
      }
    }
  }
}
