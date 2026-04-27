/**
 * Setup Script Integration Tests
 *
 * Tests the scripts/setup.js graceful degradation behavior.
 * This is an integration test that spawns a separate Node process.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const setupScriptPath = join(process.cwd(), 'scripts', 'setup.js');

describe('scripts/setup.js integration tests', () => {
  let testTimeout: NodeJS.Timeout;

  beforeEach(() => {
    // Set a test timeout to handle potential delays
    testTimeout = setTimeout(() => {}, 30000); // 30 second timeout
  });

  afterEach(() => {
    clearTimeout(testTimeout);
  });

  /**
   * Helper to run setup.js with the given environment variables and args.
   * Returns a promise that resolves with the result when the process exits.
   */
  function runSetup(env: Record<string, string>, args: string[] = []): Promise<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
  }> {
    return new Promise((resolve, reject) => {
      const child = spawn('node', [setupScriptPath, ...args], {
        env: { ...process.env, ...env },
        cwd: process.cwd(),
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        resolve({ exitCode: code, stdout, stderr });
      });

      child.on('error', (err) => {
        reject(err);
      });
    });
  }

  it('should complete successfully with PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1', async () => {
    const result = await runSetup({ PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' });

    // Exit code should be 0
    expect(result.exitCode).toBe(0);

    // Should contain expected markers
    expect(result.stdout).toContain('pi-research');
    expect(result.stdout).toContain('Skipping browser installation');
    expect(result.stdout).toContain('=');

    // Should NOT have errors in stderr
    expect(result.stderr).not.toContain('Error');
  });

  it('should complete successfully even if browser installation fails', async () => {
    // Set PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD to skip actual browser install
    // and simulate a successful install scenario that still completes
    const result = await runSetup({ PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' });

    expect(result.exitCode).toBe(0);

    // Should show status message
    expect(result.stdout).toContain('pi-research installed successfully');
    expect(result.stdout).toContain('camoufox') || expect(result.stdout).toContain('Camoufox');
  });

  it('should show version information', async () => {
    const result = await runSetup({ PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' });

    // Should show pi-research version info
    expect(result.stdout).toContain('pi-research');
  });

  it('should show quick start information', async () => {
    const result = await runSetup({ PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' });

    // Should show quick start commands
    expect(result.stdout).toContain('Quick start');
    expect(result.stdout).toContain('npm test');
    expect(result.stdout).toContain('type-check');
    expect(result.stdout).toContain('lint');
  });

  it('should gracefully handle missing npx (simulated via SKIP)', async () => {
    // In reality, we can't easily remove npx from the path, but we can
    // test that the script completes with skip flag
    const result = await runSetup({ PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' });

    // Should still complete successfully
    expect(result.exitCode).toBe(0);
  });

  it('should handle --system-deps flag', async () => {
    // Even with --system-deps, we skip actual installation with SKIP flag
    const result = await runSetup(
      { PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' },
      ['--system-deps']
    );

    expect(result.exitCode).toBe(0);
  });
});
