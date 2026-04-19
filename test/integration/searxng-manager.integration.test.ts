/**
 * DockerSearxngManager Integration Tests
 *
 * Tests the Docker container management for SearXNG.
 * Tests actual container lifecycle, concurrent sessions, error recovery.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import { DockerSearxngManager, verifyDockerInstalled, type SearxngStatus } from '../../src/infrastructure/searxng-manager.ts';

// Use a wider range of ports for each test suite to avoid conflicts
const TEST_PORTS = Array.from({ length: 50 }, (_, i) => 55800 + i);
let currentPortIndex = Math.floor(Math.random() * TEST_PORTS.length);

function getNextTestPort(): number {
  const port = TEST_PORTS[currentPortIndex % TEST_PORTS.length];
  currentPortIndex++;
  return port;
}

describe('DockerSearxngManager Integration', () => {
  const extensionDir = process.cwd();
  const testContainerBaseName = `pi-searxng-test-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const testStateDir = path.join(os.tmpdir(), `pi-test-state-manager-${Date.now()}`);
  
  let dockerAvailable: boolean = false;
  let managers: DockerSearxngManager[] = [];

  beforeAll(async () => {
    // Check Docker availability once
    const dockerInfo = await verifyDockerInstalled();
    dockerAvailable = dockerInfo.installed && dockerInfo.running;
    
    if (!dockerAvailable) {
      console.warn('Docker not running, skipping integration tests');
      return;
    }

    await fs.mkdir(testStateDir, { recursive: true });
    
    // Clean up any existing test containers before running tests
    // Don't wait for cleanup - proceed immediately
    cleanupAllTestContainers().catch(err => {
      console.warn('[test] Cleanup failed (continuing anyway):', err);
    });
  }, 120000);

  afterAll(async () => {
    if (!dockerAvailable) return;
    
    // Stop all managers
    for (const manager of managers) {
      try {
        await manager.stop();
      } catch {
        // Ignore errors
      }
    }
    
    // Clean up state directory
    try {
      await fs.rm(testStateDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    
    // Final cleanup of any remaining test containers
    await cleanupAllTestContainers();
  }, 120000);

  beforeEach(async () => {
    // Nothing to do before each test - managers are created per test
  });

  afterEach(async () => {
    // Clean up manager after each test
    if (!dockerAvailable) return;
    
    // Stop the last manager if exists
    const lastManager = managers.pop();
    if (lastManager) {
      try {
        await lastManager.stop();
      } catch {
        // Ignore errors
      }
    }
  });

  describe('Docker Availability', () => {
    it('should verify docker is installed and running', async () => {
      const dockerInfo = await verifyDockerInstalled();
      
      if (!dockerAvailable) {
        expect(dockerInfo.installed || dockerInfo.running).toBe(false);
        return;
      }
      
      expect(dockerInfo.installed).toBe(true);
      expect(dockerInfo.running).toBe(true);
    });
  });

  describe('Container Lifecycle', () => {
    it('should acquire and start a container successfully', async () => {
      if (!dockerAvailable) return;

      const port = getNextTestPort();
      const testSessionId1 = `test-session-lifecycle-${Date.now()}`;
      const testContainerName = `${testContainerBaseName}-lifecycle`;
      
      const manager = new DockerSearxngManager(extensionDir, {
        containerName: testContainerName,
        port,
        healthTimeout: 60000,
        stateDir: testStateDir,
      });
      
      managers.push(manager);
      
      await manager.acquire(testSessionId1);
      
      const status = await manager.getStatus();
      expect(status.healthy).toBe(true);
      expect(status.dockerAvailable).toBe(true);
      expect(status.containerName).toBe(testContainerName);
      expect(status.port).toBe(port);
      expect(status.url).toBe(`http://localhost:${port}`);
      expect(status.containerId).toBeDefined();
      expect(status.containerId).toMatch(/^[a-f0-9]{12,}$/);
    }, 90000);

    it('should respond to HTTP requests after startup', async () => {
      if (!dockerAvailable) return;

      const port = getNextTestPort();
      const testSessionId1 = `test-session-http-${Date.now()}`;
      const testContainerName = `${testContainerBaseName}-http`;
      
      const manager = new DockerSearxngManager(extensionDir, {
        containerName: testContainerName,
        port,
        healthTimeout: 60000,
        stateDir: testStateDir,
      });
      
      managers.push(manager);
      
      await manager.acquire(testSessionId1);
      const status = await manager.getStatus();

      if (!status.healthy || !status.url) {
        throw new Error('Container not healthy or URL not available');
      }

      // Test that container actually responds
      const response = await fetch(status.url, {
        method: 'GET',
        signal: AbortSignal.timeout(10000),
      });

      expect(response.status).toBeGreaterThanOrEqual(200);
      expect(response.status).toBeLessThan(600);
    });

    it('should return correct status structure', async () => {
      if (!dockerAvailable) return;

      const port = getNextTestPort();
      const testSessionId1 = `test-session-status-${Date.now()}`;
      const testContainerName = `${testContainerBaseName}-status`;
      
      const manager = new DockerSearxngManager(extensionDir, {
        containerName: testContainerName,
        port,
        healthTimeout: 60000,
        stateDir: testStateDir,
      });
      
      managers.push(manager);
      
      await manager.acquire(testSessionId1);
      const status = await manager.getStatus();

      expect(status).toHaveProperty('dockerAvailable');
      expect(status).toHaveProperty('healthy');
      expect(status).toHaveProperty('url');
      expect(status).toHaveProperty('containerName');
      expect(status).toHaveProperty('port');
      expect(status).toHaveProperty('containerId');
      expect(typeof status.dockerAvailable).toBe('boolean');
      expect(typeof status.healthy).toBe('boolean');
      expect(typeof status.url).toBe('string');
      expect(typeof status.port).toBe('number');
    });

    it('should release container when session ends', async () => {
      if (!dockerAvailable) return;

      const port = getNextTestPort();
      const testSessionId1 = `test-session-release-${Date.now()}`;
      const testContainerName = `${testContainerBaseName}-release`;
      
      const manager = new DockerSearxngManager(extensionDir, {
        containerName: testContainerName,
        port,
        healthTimeout: 60000,
        stateDir: testStateDir,
      });
      
      managers.push(manager);
      
      await manager.acquire(testSessionId1);
      expect((await manager.getStatus()).containerId).toBeDefined();

      await manager.release(testSessionId1);

      // Container should be stopped
      const status = await manager.getStatus();
      expect(status.containerId).toBeUndefined();
      expect(status.healthy).toBe(false);
    });

    it('should handle multiple acquire/release cycles', async () => {
      if (!dockerAvailable) return;

      const port = getNextTestPort();
      const testSessionId1 = `test-session-cycle-${Date.now()}`;
      const testContainerName = `${testContainerBaseName}-cycle`;
      
      const manager = new DockerSearxngManager(extensionDir, {
        containerName: testContainerName,
        port,
        healthTimeout: 60000,
        stateDir: testStateDir,
      });
      
      managers.push(manager);
      
      // First cycle
      await manager.acquire(testSessionId1);
      expect((await manager.getStatus()).containerId).toBeDefined();
      await manager.release(testSessionId1);
      expect((await manager.getStatus()).containerId).toBeUndefined();

      // Second cycle
      await manager.acquire(testSessionId1);
      expect((await manager.getStatus()).containerId).toBeDefined();
      await manager.release(testSessionId1);
      expect((await manager.getStatus()).containerId).toBeUndefined();
    });
  });

  describe('Concurrent Sessions', () => {
    it('should support multiple sessions acquiring the same container', async () => {
      if (!dockerAvailable) return;

      const port = getNextTestPort();
      const testSessionId1 = `test-session-concurrent-1-${Date.now()}`;
      const testSessionId2 = `test-session-concurrent-2-${Date.now()}`;
      const testContainerName = `${testContainerBaseName}-concurrent`;
      
      const manager = new DockerSearxngManager(extensionDir, {
        containerName: testContainerName,
        port,
        healthTimeout: 60000,
        stateDir: testStateDir,
      });
      
      managers.push(manager);
      
      // First session acquires
      await manager.acquire(testSessionId1);
      const status1 = await manager.getStatus();
      expect(status1.containerId).toBeDefined();

      // Second session acquires (should reuse)
      await manager.acquire(testSessionId2);
      const status2 = await manager.getStatus();
      expect(status2.containerId).toBe(status1.containerId);

      // Both sessions are tracked
      await manager.release(testSessionId1);
      const status3 = await manager.getStatus();
      expect(status3.containerId).toBeDefined(); // Still has session2

      await manager.release(testSessionId2);
      const status4 = await manager.getStatus();
      expect(status4.containerId).toBeUndefined(); // All sessions released
    });

    it('should not stop container while any session is active', async () => {
      if (!dockerAvailable) return;

      const port = getNextTestPort();
      const testSessionId1 = `test-session-active-1-${Date.now()}`;
      const testSessionId2 = `test-session-active-2-${Date.now()}`;
      const testContainerName = `${testContainerBaseName}-active`;
      
      const manager = new DockerSearxngManager(extensionDir, {
        containerName: testContainerName,
        port,
        healthTimeout: 60000,
        stateDir: testStateDir,
      });
      
      managers.push(manager);
      
      await manager.acquire(testSessionId1);
      const containerId1 = (await manager.getStatus()).containerId;

      await manager.acquire(testSessionId2);
      const containerId2 = (await manager.getStatus()).containerId;

      expect(containerId1).toBe(containerId2);

      // Release first session
      await manager.release(testSessionId1);
      const status = await manager.getStatus();
      expect(status.containerId).toBe(containerId1); // Still running

      // Release second session - now should stop
      await manager.release(testSessionId2);
      const finalStatus = await manager.getStatus();
      expect(finalStatus.containerId).toBeUndefined();
    });

    it('should handle rapid acquire/release from multiple sessions', async () => {
      if (!dockerAvailable) return;

      const port = getNextTestPort();
      const testContainerName = `${testContainerBaseName}-rapid`;
      
      const manager = new DockerSearxngManager(extensionDir, {
        containerName: testContainerName,
        port,
        healthTimeout: 60000,
        stateDir: testStateDir,
      });
      
      managers.push(manager);
      
      const sessions = Array.from({ length: 5 }, (_, i) => `session-rapid-${i}-${Date.now()}`);

      // All sessions acquire
      for (const session of sessions) {
        await manager.acquire(session);
      }
      const status = await manager.getStatus();
      expect(status.containerId).toBeDefined();

      // All sessions release
      for (const session of sessions) {
        await manager.release(session);
      }
      const finalStatus = await manager.getStatus();
      expect(finalStatus.containerId).toBeUndefined();
    });
  });

  describe('Error Handling and Edge Cases', () => {
    it('should handle acquire after release gracefully', async () => {
      if (!dockerAvailable) return;

      const port = getNextTestPort();
      const testSessionId1 = `test-session-after-${Date.now()}`;
      const testContainerName = `${testContainerBaseName}-after`;
      
      const manager = new DockerSearxngManager(extensionDir, {
        containerName: testContainerName,
        port,
        healthTimeout: 60000,
        stateDir: testStateDir,
      });
      
      managers.push(manager);
      
      await manager.acquire(testSessionId1);
      await manager.release(testSessionId1);

      // Should be able to acquire again
      await expect(manager.acquire(testSessionId1)).resolves.not.toThrow();
      expect((await manager.getStatus()).containerId).toBeDefined();
    });

    it('should handle duplicate release calls', async () => {
      if (!dockerAvailable) return;

      const port = getNextTestPort();
      const testSessionId1 = `test-session-dup-${Date.now()}`;
      const testContainerName = `${testContainerBaseName}-dup`;
      
      const manager = new DockerSearxngManager(extensionDir, {
        containerName: testContainerName,
        port,
        healthTimeout: 60000,
        stateDir: testStateDir,
      });
      
      managers.push(manager);
      
      await manager.acquire(testSessionId1);
      await manager.release(testSessionId1);

      // Duplicate release should not throw
      await expect(manager.release(testSessionId1)).resolves.not.toThrow();
    });

    it('should handle release of unknown session gracefully', async () => {
      if (!dockerAvailable) return;

      const manager = new DockerSearxngManager(extensionDir, {
        containerName: 'unused-container',
        port: getNextTestPort(),
        healthTimeout: 60000,
        stateDir: testStateDir,
      });
      
      managers.push(manager);
      
      await expect(
        manager.release('unknown-session-id')
      ).resolves.not.toThrow();
    });

    it('should stop container cleanly on error', async () => {
      if (!dockerAvailable) return;

      const port = getNextTestPort();
      const testSessionId1 = `test-session-error-${Date.now()}`;
      const testContainerName = `${testContainerBaseName}-error`;
      
      const manager = new DockerSearxngManager(extensionDir, {
        containerName: testContainerName,
        port,
        healthTimeout: 60000,
        stateDir: testStateDir,
      });
      
      managers.push(manager);
      
      await manager.acquire(testSessionId1);
      const containerId = (await manager.getStatus()).containerId;

      await manager.stop();

      const status = await manager.getStatus();
      expect(status.containerId).toBeUndefined();
      expect(status.healthy).toBe(false);
    });

    it('should handle stop when no container is running', async () => {
      if (!dockerAvailable) return;

      const manager = new DockerSearxngManager(extensionDir, {
        containerName: 'unused-container-stop',
        port: getNextTestPort(),
        healthTimeout: 60000,
        stateDir: testStateDir,
      });
      
      managers.push(manager);
      
      // Ensure no container is running
      await manager.stop();

      // Should not throw
      await expect(manager.stop()).resolves.not.toThrow();
    });
  });

  describe('Status Reporting', () => {
    it('should report correct status when no container is running', async () => {
      if (!dockerAvailable) return;

      const manager = new DockerSearxngManager(extensionDir, {
        containerName: 'unused-container-status',
        port: getNextTestPort(),
        healthTimeout: 60000,
        stateDir: testStateDir,
      });
      
      managers.push(manager);
      
      // Ensure no container
      await manager.stop();

      const status = await manager.getStatus();
      expect(status.dockerAvailable).toBe(true);
      expect(status.healthy).toBe(false);
      expect(status.containerId).toBeUndefined();
      // url, port, containerName are optional when container is not running
      expect(status.url).toBeUndefined();
      expect(status.port).toBeUndefined();
      expect(status.containerName).toBeUndefined();
    });

    it('should report correct status when container is running', async () => {
      if (!dockerAvailable) return;

      const port = getNextTestPort();
      const testSessionId1 = `test-session-report-${Date.now()}`;
      const testContainerName = `${testContainerBaseName}-report`;
      
      const manager = new DockerSearxngManager(extensionDir, {
        containerName: testContainerName,
        port,
        healthTimeout: 60000,
        stateDir: testStateDir,
      });
      
      managers.push(manager);
      
      await manager.acquire(testSessionId1);
      const status = await manager.getStatus();

      expect(status.dockerAvailable).toBe(true);
      expect(status.healthy).toBe(true);
      expect(status.containerId).toBeDefined();
      expect(status.url).toBeDefined();
      expect(status.port).toBeDefined();
      expect(status.containerName).toBeDefined();
      expect(status.url).toBe(`http://localhost:${port}`);
      expect(status.port).toBe(port);
      expect(status.containerName).toBe(testContainerName);
    });

    it('should report consistent status across multiple calls', async () => {
      if (!dockerAvailable) return;

      const port = getNextTestPort();
      const testSessionId1 = `test-session-consist-${Date.now()}`;
      const testContainerName = `${testContainerBaseName}-consist`;
      
      const manager = new DockerSearxngManager(extensionDir, {
        containerName: testContainerName,
        port,
        healthTimeout: 60000,
        stateDir: testStateDir,
      });
      
      managers.push(manager);
      
      await manager.acquire(testSessionId1);

      const status1 = await manager.getStatus();
      const status2 = await manager.getStatus();
      const status3 = await manager.getStatus();

      expect(status1.containerId).toBe(status2.containerId);
      expect(status2.containerId).toBe(status3.containerId);
      expect(status1.healthy).toBe(status2.healthy);
      expect(status2.healthy).toBe(status3.healthy);
    });
  });
});

/**
 * Helper function to clean up all test containers
 */
async function cleanupAllTestContainers(): Promise<void> {
  try {
    const Docker = (await import('dockerode')).default;
    const docker = new Docker();
    
    const containers = await docker.listContainers({ all: true });
    
    for (const container of containers) {
      const names = container.Names || [];
      const testName = names.find(name => name.includes('pi-searxng-test-'));
      
      if (testName) {
        try {
          const containerObj = docker.getContainer(container.Id);
          if (container.State === 'running') {
            await containerObj.stop({ t: 2 });
          }
          await containerObj.remove({ force: true });
          console.log(`[test] Cleaned up test container: ${testName}`);
        } catch (err) {
          // Ignore if already gone
        }
      }
    }
    // Give Docker a moment to settle
    await new Promise(resolve => setTimeout(resolve, 1000));
  } catch (err) {
    console.warn('[test] Failed to cleanup test containers:', err);
  }
}
