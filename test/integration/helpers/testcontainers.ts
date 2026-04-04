/**
 * Testcontainers Integration Test Helpers
 *
 * Utilities for managing Docker containers in integration tests.
 */

import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { logger } from '../../../src/logger.js';

/**
 * Test container manager
 */
export class TestContainerManager {
  private containers: Map<string, StartedTestContainer> = new Map();

  /**
   * Start a container and track it for cleanup
   */
  async startContainer(
    name: string,
    image: string,
    options?: {
      port?: number;
      env?: Record<string, string>;
      cmd?: string[];
      healthCheck?: {
        test: string[];
        interval: number;
        timeout: number;
        retries: number;
      };
    }
  ): Promise<StartedTestContainer> {
    logger.log(`Starting container: ${name} (${image})`);

    let container = new GenericContainer(image);

    if (options?.port) {
      container = container.withExposedPorts(options.port);
    }

    if (options?.env) {
      container = container.withEnvironment(options.env);
    }

    if (options?.cmd) {
      container = container.withCommand(options.cmd);
    }

    const started = await container.start();
    this.containers.set(name, started);

    logger.log(`Container started: ${name}`);
    return started;
  }

  /**
   * Get a started container by name
   */
  getContainer(name: string): StartedTestContainer | undefined {
    return this.containers.get(name);
  }

  /**
   * Get container port mapping
   */
  getContainerPort(name: string, internalPort: number): number {
    const container = this.containers.get(name);
    if (!container) {
      throw new Error(`Container not found: ${name}`);
    }
    return container.getMappedPort(internalPort);
  }

  /**
   * Get container host
   */
  getContainerHost(name: string): string {
    const container = this.containers.get(name);
    if (!container) {
      throw new Error(`Container not found: ${name}`);
    }
    return container.getHost();
  }

  /**
   * Get full container URL
   */
  getContainerUrl(name: string, internalPort: number, protocol: string = 'http'): string {
    const host = this.getContainerHost(name);
    const port = this.getContainerPort(name, internalPort);
    return `${protocol}://${host}:${port}`;
  }

  /**
   * Stop a container
   */
  async stopContainer(name: string): Promise<void> {
    const container = this.containers.get(name);
    if (container) {
      logger.log(`Stopping container: ${name}`);
      await container.stop();
      this.containers.delete(name);
    }
  }

  /**
   * Stop all containers
   */
  async stopAllContainers(): Promise<void> {
    const names = Array.from(this.containers.keys());

    for (const name of names) {
      await this.stopContainer(name);
    }
  }

  /**
   * Get all containers
   */
  getAllContainers(): Map<string, StartedTestContainer> {
    return new Map(this.containers);
  }
}

// Singleton instance
let globalManager: TestContainerManager | undefined;

/**
 * Get global container manager
 */
export function getContainerManager(): TestContainerManager {
  if (!globalManager) {
    globalManager = new TestContainerManager();
  }
  return globalManager;
}

/**
 * Wait for container to be ready
 */
export async function waitForContainer(
  url: string,
  maxAttempts: number = 30,
  delay: number = 1000
): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(url, { method: 'HEAD' });
      if (response.ok || response.status === 404) {
        logger.log(`Container ready: ${url}`);
        return;
      }
    } catch {
      // Container not ready yet
    }

    await new Promise(resolve => setTimeout(resolve, delay));
  }

  throw new Error(`Container did not become ready: ${url}`);
}

/**
 * Health check for container
 */
export async function healthCheck(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(url, { method: 'HEAD', signal: controller.signal }).finally(() => clearTimeout(timeoutId));
    return response.ok || response.status === 404;
  } catch {
    return false;
  }
}
