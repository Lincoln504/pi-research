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
      // process.execPath, not a bare 'node': the rest of this suite already does
      // this, and a PATH lookup can resolve a different interpreter (nvm-windows,
      // Volta, a portable Node) than the one running the tests.
      const child = spawn(process.execPath, [setupScriptPath, ...args], {
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
    // Case-insensitive: setup.cjs emits `ERROR:` (uppercase), which the old
    // case-sensitive `not.toContain('Error')` could never match.
    expect(result.stderr).not.toMatch(/error/i);
  });

  // Honest scope: in setup.cjs the entire --system-deps install block lives
  // inside the else-branch of the PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD check, so
  // with the skip env set (mandatory here — the real branch drives the system
  // package manager via `npx playwright install-deps`, which needs root, and
  // unsetting the skip would also download the ~100MB browser) the system-deps
  // branch is intentionally NOT exercised. This is a skip-path smoke test only:
  // the script must accept the flag and stay clean, nothing more.
  it('should accept --system-deps on the skip path (install branch not exercised — needs root/package managers)', async () => {
    const result = await runSetup(
      { PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' },
      ['--system-deps']
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('pi-research');
    expect(result.stdout).toContain('skipping browser download');
    expect(result.stderr).not.toMatch(/error/i);
  });
});
