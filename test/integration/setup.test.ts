/**
 * Setup Script Integration Tests
 *
 * Tests the scripts/setup.cjs graceful degradation behavior.
 * This is an integration test that spawns a separate Node process.
 */

import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const setupScriptPath = join(process.cwd(), 'scripts', 'setup.cjs');

describe('scripts/setup.cjs integration tests', () => {

  /**
   * Helper to run setup.cjs with the given environment variables and args.
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

  it('should complete successfully and show expected output', async () => {
    const result = await runSetup({ PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('pi-research');
    expect(result.stdout).toContain('skipping browser download');
    expect(result.stdout).toContain('PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1');
    expect(result.stderr).not.toContain('Error');
  });

  it('should handle --system-deps flag without error', async () => {
    const result = await runSetup(
      { PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' },
      ['--system-deps']
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('pi-research');
  });
});
