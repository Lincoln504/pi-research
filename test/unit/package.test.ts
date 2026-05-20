/**
 * Package Distribution Tests
 *
 * Tests that npm pack includes the expected files and nothing else.
 * Catches accidental inclusion of test files, temporary files, secrets, etc.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('npm pack', () => {
  let tempDir: string;
  let packFiles: string[] = [];

  beforeAll(() => {
    // Run npm pack --dry-run once for all tests to save time
    packFiles = getPackFiles();
    // Create a temporary directory for packing (if needed by other tests, though current ones only use the list)
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-research-pack-'));
  });

  afterAll(() => {
    // Cleanup
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function getPackFiles(): string[] {
    // Run npm pack --dry-run to get the list of files that would be included
    // Note: npm pack writes to stderr, so we redirect to stdout with 2>&1
    const output = execSync('npm pack --dry-run 2>&1', {
      encoding: 'utf8',
      cwd: process.cwd(),
    });

    // Parse the output - it looks like:
    // npm notice
    // npm notice 📦 @lincoln504/pi-research@0.1.13
    // npm notice === Tarball Contents ===
    // npm notice ...
    // npm notice 1.2kB  package.json
    // npm notice 982B  config/file.txt
    // npm notice ...
    const lines = output.split('\n');
    const files: string[] = [];

    for (const line of lines) {
      if (line.startsWith('npm notice ') && (line.includes('kB') || line.match(/\d+B\s/))) {
        // Extract the file path (last part of the line after the size)
        // Format: "npm notice 1.2kB  filename" or "npm notice 982B  filename" or "npm notice 189.7kB  filename"
        const parts = line.trim().split(/\s+/);
        // The last part is the filename
        const filename = parts[parts.length - 1];
        if (filename && filename !== '📦' && !filename.startsWith('@lincoln504/')) {
          files.push(filename);
        }
      }
    }

    return files;
  }

  it('should include package.json', () => {
    expect(packFiles).toContain('package.json');
  });

  it('should include README.md', () => {
    expect(packFiles).toContain('README.md');
  });

  it('should include LICENSE', () => {
    expect(packFiles).toContain('LICENSE');
  });

  it('should include src directory', () => {
    const srcFiles = packFiles.filter(f => f.startsWith('src/'));
    expect(srcFiles.length).toBeGreaterThan(0);
  });

  it('should include scripts directory', () => {
    const scriptsFiles = packFiles.filter(f => f.startsWith('scripts/'));
    expect(scriptsFiles.length).toBeGreaterThan(0);
  });

  it('should include TypeScript source files (.ts)', () => {
    const tsFiles = packFiles.filter(f => f.endsWith('.ts'));
    expect(tsFiles.length).toBeGreaterThan(0);
  });

  it('should NOT include test files', () => {
    const testFiles = packFiles.filter(f => f.includes('.test.ts') || f.includes('.test.js'));
    expect(testFiles.length).toBe(0);
  });

  it('should NOT include test/integration directory', () => {
    const integrationTestFiles = packFiles.filter(f => f.startsWith('test/integration/'));
    expect(integrationTestFiles.length).toBe(0);
  });

  it('should NOT include test/unit directory', () => {
    const unitTestFiles = packFiles.filter(f => f.startsWith('test/unit/'));
    expect(unitTestFiles.length).toBe(0);
  });

  it('should NOT include .git directory', () => {
    const gitFiles = packFiles.filter(f => f.startsWith('.git/') || f === '.gitignore');
    expect(gitFiles.length).toBe(0);
  });

  it('should NOT include .github directory', () => {
    const githubFiles = packFiles.filter(f => f.startsWith('.github/'));
    expect(githubFiles.length).toBe(0);
  });

  it('should NOT include config/tooling (test config)', () => {
    const toolingFiles = packFiles.filter(f => f.startsWith('config/tooling/'));
    expect(toolingFiles.length).toBe(0);
  });

  it('should NOT include Vitest config files', () => {
    const vitestFiles = packFiles.filter(f => f.includes('vitest'));
    expect(vitestFiles.length).toBe(0);
  });

  it('should NOT include ESLint config files', () => {
    const eslintFiles = packFiles.filter(f => f.includes('eslint'));
    expect(eslintFiles.length).toBe(0);
  });

  it('should NOT include TypeScript config files', () => {
    const tsconfigFiles = packFiles.filter(f => f === 'tsconfig.json');
    expect(tsconfigFiles.length).toBe(0);
  });

  it('should NOT include temporary files', () => {
    const tempFiles = packFiles.filter(f => 
      f.endsWith('.tmp') || 
      f.endsWith('.temp') || 
      f.endsWith('.log') ||
      f.endsWith('.tgz')
    );
    expect(tempFiles.length).toBe(0);
  });

  it('should NOT include .env files', () => {
    const envFiles = packFiles.filter(f => f === '.env' || f === '.env.example');
    expect(envFiles.length).toBe(0);
  });

  it('should include main entry point', () => {
    expect(packFiles).toContain('scripts/setup.cjs');
  });

  it('should have reasonable total file count', () => {
    // We expect around 100-200 files (not too many, not too few)
    expect(packFiles.length).toBeGreaterThan(50);
    expect(packFiles.length).toBeLessThan(500);
  });

  it('should include source files from all key modules', () => {
    // Check for key source files
    expect(packFiles.some(f => f.startsWith('src/infrastructure/'))).toBe(true);
    expect(packFiles.some(f => f.startsWith('src/orchestration/'))).toBe(true);
    expect(packFiles.some(f => f.startsWith('src/web-research/'))).toBe(true);
    expect(packFiles.some(f => f.startsWith('src/utils/'))).toBe(true);
    expect(packFiles.some(f => f.startsWith('src/tui/'))).toBe(true);
    expect(packFiles.some(f => f === 'src/index.ts')).toBe(true);
  });

  it('should NOT include package-lock.json', () => {
    expect(packFiles.includes('package-lock.json')).toBe(false);
  });

  it('should NOT include node_modules', () => {
    const nodeModulesFiles = packFiles.filter(f => f.includes('node_modules'));
    expect(nodeModulesFiles.length).toBe(0);
  });

  it('should NOT include CI/CD workflow files', () => {
    const workflowFiles = packFiles.filter(f => f.startsWith('.github/') || f.includes('workflow'));
    expect(workflowFiles.length).toBe(0);
  });

  it('should NOT include .nvmrc', () => {
    expect(packFiles.includes('.nvmrc')).toBe(false);
  });
});

