import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import { DockerSearxngManager, verifyDockerInstalled } from '../../src/infrastructure/searxng-manager.ts';

describe('DockerSearxngManager Integration', () => {
  const extensionDir = process.cwd();
  const testSessionId = `test-session-${Date.now()}`;
  const testContainerName = `pi-searxng-test-${Date.now()}`;
  const testStateDir = path.join(os.tmpdir(), `pi-test-state-manager-${Date.now()}`);
  
  let manager: DockerSearxngManager;

  beforeAll(async () => {
    // Skip if Docker is not available
    const dockerInfo = await verifyDockerInstalled();
    if (!dockerInfo.running) {
      console.warn('Docker not running, skipping integration tests');
      return;
    }

    await fs.mkdir(testStateDir, { recursive: true });
    
    manager = new DockerSearxngManager(extensionDir, {
      containerName: testContainerName,
      port: 55733, // Use different port than default
      healthTimeout: 180000,
      stateDir: testStateDir,
    });
  });

  afterAll(async () => {
    if (manager) {
      await manager.stop();
    }
    try {
      await fs.rm(testStateDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  }, 60000);

  it('should verify docker is installed', async () => {
    const dockerInfo = await verifyDockerInstalled();
    if (!dockerInfo.running) return; // Skip if no docker
    
    expect(dockerInfo.installed).toBe(true);
    expect(dockerInfo.running).toBe(true);
  });

  it('should acquire and start a container', async () => {
    const dockerInfo = await verifyDockerInstalled();
    if (!dockerInfo.running) return;

    await manager.acquire(testSessionId);
    
    const status = await manager.getStatus();
    expect(status.healthy).toBe(true);
    expect(status.containerName).toBe(testContainerName);
    expect(status.port).toBe(55733);
  }, 200000);

  it('should reuse existing container for same session', async () => {
    const dockerInfo = await verifyDockerInstalled();
    if (!dockerInfo.running) return;

    await manager.acquire(testSessionId);
    
    const status = await manager.getStatus();
    expect(status.healthy).toBe(true);
  });

  it('should show healthy status', async () => {
    const dockerInfo = await verifyDockerInstalled();
    if (!dockerInfo.running) return;

    const status = await manager.getStatus();
    expect(status.dockerAvailable).toBe(true);
    expect(status.healthy).toBe(true);
    expect(status.url).toBe('http://localhost:55733');
  });

  it('should release container', async () => {
    const dockerInfo = await verifyDockerInstalled();
    if (!dockerInfo.running) return;

    await manager.release(testSessionId);
    
    // In singleton mode, if it was the only session, it should stop
    const status = await manager.getStatus();
    expect(status.containerId).toBeUndefined();
  });
});
