/**
 * Tor Manager
 *
 * Manages Tor proxy for SearXNG to avoid IP blocking.
 * Optional feature - disabled by default.
 *
 * When enabled:
 * - Checks if Tor is installed and running
 * - Provides proxy URL (socks5://127.0.0.1:9050)
 * - Errors gracefully if Tor is not available
 */

import { logger } from './logger.js';
import { spawn, ChildProcess } from 'node:child_process';
import * as net from 'node:net';

// Tor configuration
const TOR_CONTROL_PORT = 9051;
const TOR_SOCKS_PORT = 9050;

export type TorStatus = 'disabled' | 'checking' | 'available' | 'unavailable' | 'starting' | 'error';

export interface TorManagerConfig {
  enabled: boolean;
  socksPort?: number;
  controlPort?: number;
  autoStart?: boolean;
}

/**
 * TorManager class
 */
export class TorManager {
  private config: TorManagerConfig;
  private torProcess: ChildProcess | null = null;
  private status: TorStatus = 'disabled';
  private errorMessage: string | null = null;

  constructor(config: TorManagerConfig) {
    this.config = {
      socksPort: TOR_SOCKS_PORT,
      controlPort: TOR_CONTROL_PORT,
      autoStart: false,
      ...config,
    };
  }

  /**
   * Get current status
   */
  getStatus(): TorStatus {
    return this.status;
  }

  /**
   * Get error message if status is 'error'
   */
  getError(): string | null {
    return this.errorMessage;
  }

  /**
   * Get proxy URL for SearXNG configuration
   */
  getProxyUrl(): string | null {
    if (this.status !== 'available') {
      return null;
    }
    return `socks5://127.0.0.1:${this.config.socksPort!}`;
  }

  /**
   * Check if Tor is installed
   */
  private async isTorInstalled(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const process = spawn('tor', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let hasOutput = false;

      process.stdout.on('data', () => {
        hasOutput = true;
      });

      process.on('close', (code) => {
        resolve(hasOutput && code === 0);
      });

      process.on('error', () => {
        resolve(false);
      });

      // Timeout after 2 seconds
      setTimeout(() => {
        process.kill();
        resolve(false);
      }, 2000);
    });
  }

  /**
   * Check if Tor is already running
   */
  private async isTorRunning(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(2000);

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

      socket.connect(this.config.socksPort!, '127.0.0.1');
    });
  }

  /**
   * Initialize Tor
   */
  async initialize(): Promise<void> {
    if (!this.config.enabled) {
      logger.log('[Tor Manager] Tor is disabled in configuration');
      this.status = 'disabled';
      return;
    }

    logger.log('[Tor Manager] Initializing Tor...');
    this.status = 'checking';
    this.errorMessage = null;

    // Check if Tor is installed
    const installed = await this.isTorInstalled();
    if (!installed) {
      this.status = 'unavailable';
      this.errorMessage = 'Tor is not installed on this system. Please install Tor to use Tor proxy.';
      throw new Error(
        'Tor is enabled in configuration but not installed. ' +
        'Install Tor with: brew install tor (macOS) or apt install tor (Linux/Ubuntu)'
      );
    }

    // Check if Tor is already running
    const running = await this.isTorRunning();
    if (running) {
      this.status = 'available';
      logger.log(`[Tor Manager] Tor is already running on port ${this.config.socksPort}`);
      return;
    }

    // Try to start Tor if autoStart is enabled
    if (this.config.autoStart) {
      logger.log('[Tor Manager] Attempting to start Tor...');
      this.status = 'starting';
      try {
        await this.startTor();
        this.status = 'available';
        logger.log(`[Tor Manager] Tor started successfully on port ${this.config.socksPort}`);
      } catch (error) {
        this.status = 'error';
        this.errorMessage = error instanceof Error ? error.message : String(error);
        logger.error('[Tor Manager] Failed to start Tor:', error);
        throw error;
      }
    } else {
      this.status = 'unavailable';
      this.errorMessage = `Tor is not running on port ${this.config.socksPort}. Start Tor manually or set PI_RESEARCH_TOR_AUTO_START=true.`;
      throw new Error(
        `Tor is enabled but not running on port ${this.config.socksPort}. ` +
        `Start Tor manually or set PI_RESEARCH_TOR_AUTO_START=true.`
      );
    }
  }

  /**
   * Start Tor process
   */
  private async startTor(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const args = [
        `--SocksPort ${this.config.socksPort}`,
        '--ControlPort 0', // Disable control port for simplicity
        '--CookieAuthentication 0',
        '--DataDirectory /tmp/tor-data-pi-research',
        '--Log notice stdout',
      ];

      logger.log(`[Tor Manager] Starting Tor with args: tor ${args.join(' ')}`);

      this.torProcess = spawn('tor', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      });

      let bootstrapped = false;

      const timeout = setTimeout(() => {
        if (!bootstrapped && this.torProcess) {
          this.torProcess.kill();
          reject(new Error('Tor failed to bootstrap within 30 seconds'));
        }
      }, 30000);

      // Listen for "Bootstrapped" message in stdout
      this.torProcess.stdout?.on('data', (data) => {
        const output = data.toString();
        logger.log('[Tor Manager]', output.trim());

        if (output.includes('Bootstrapped 100%')) {
          bootstrapped = true;
          clearTimeout(timeout);
          resolve();
        }
      });

      // Listen for errors
      this.torProcess.stderr?.on('data', (data) => {
        const output = data.toString();
        if (!output.includes('[warn]') && !output.includes('[notice]')) {
          logger.error('[Tor Manager]', output.trim());
        }
      });

      this.torProcess.on('error', (error) => {
        clearTimeout(timeout);
        reject(new Error(`Failed to start Tor process: ${error.message}`));
      });

      this.torProcess.on('close', (code) => {
        if (!bootstrapped) {
          clearTimeout(timeout);
          reject(new Error(`Tor process exited with code ${code}`));
        }
      });
    });
  }

  /**
   * Shutdown Tor (only if we started it)
   */
  async shutdown(): Promise<void> {
    if (this.torProcess && this.config.autoStart) {
      logger.log('[Tor Manager] Shutting down Tor...');
      this.torProcess.kill('SIGTERM');

      // Wait up to 5 seconds for graceful shutdown
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 5000);
        this.torProcess?.on('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      // Force kill if still running
      if (this.torProcess) {
        this.torProcess.kill('SIGKILL');
      }

      this.torProcess = null;
      logger.log('[Tor Manager] Tor shut down');
    }

    this.status = 'disabled';
    this.errorMessage = null;
  }

  /**
   * Get status information for display
   */
  getStatusInfo(): { status: TorStatus; proxyUrl: string | null; error: string | null } {
    return {
      status: this.status,
      proxyUrl: this.getProxyUrl(),
      error: this.errorMessage,
    };
  }
}

// Singleton instance
let torManager: TorManager | null = null;

/**
 * Get or create TorManager singleton
 */
export function getTorManager(): TorManager | null {
  return torManager;
}

/**
 * Initialize TorManager singleton
 */
export async function initTorManager(config: TorManagerConfig): Promise<TorManager> {
  if (torManager === null) {
    torManager = new TorManager(config);
  }
  await torManager.initialize();
  return torManager;
}

/**
 * Shutdown TorManager singleton
 */
export async function shutdownTorManager(): Promise<void> {
  if (torManager !== null) {
    await torManager.shutdown();
    torManager = null;
  }
}
