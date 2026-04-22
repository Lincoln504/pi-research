/**
 * Package Distribution Tests
 *
 * Tests that npm pack includes the expected files and nothing else.
 * Catches accidental inclusion of test files, temporary files, secrets, etc.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('npm pack', () => {
  let tempDir: string;

  beforeEach(() => {
    // Create a temporary directory for packing
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-research-pack-'));
  });

  afterEach(() => {
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
    const files = getPackFiles();
    expect(files).toContain('package.json');
  });

  it('should include README.md', () => {
    const files = getPackFiles();
    expect(files).toContain('README.md');
  });

  it('should include LICENSE', () => {
    const files = getPackFiles();
    expect(files).toContain('LICENSE');
  });

  it('should include src directory', () => {
    const files = getPackFiles();
    const srcFiles = files.filter(f => f.startsWith('src/'));
    expect(srcFiles.length).toBeGreaterThan(0);
  });

  it('should include scripts directory', () => {
    const files = getPackFiles();
    const scriptsFiles = files.filter(f => f.startsWith('scripts/'));
    expect(scriptsFiles.length).toBeGreaterThan(0);
  });

  it('should include TypeScript source files (.ts)', () => {
    const files = getPackFiles();
    const tsFiles = files.filter(f => f.endsWith('.ts'));
    expect(tsFiles.length).toBeGreaterThan(0);
  });

  it('should NOT include test files', () => {
    const files = getPackFiles();
    const testFiles = files.filter(f => f.includes('.test.ts') || f.includes('.test.js'));
    expect(testFiles.length).toBe(0);
  });

  it('should NOT include test/integration directory', () => {
    const files = getPackFiles();
    const integrationTestFiles = files.filter(f => f.startsWith('test/integration/'));
    expect(integrationTestFiles.length).toBe(0);
  });

  it('should NOT include test/unit directory', () => {
    const files = getPackFiles();
    const unitTestFiles = files.filter(f => f.startsWith('test/unit/'));
    expect(unitTestFiles.length).toBe(0);
  });

  it('should NOT include .git directory', () => {
    const files = getPackFiles();
    const gitFiles = files.filter(f => f.startsWith('.git/') || f === '.gitignore');
    expect(gitFiles.length).toBe(0);
  });

  it('should NOT include .github directory', () => {
    const files = getPackFiles();
    const githubFiles = files.filter(f => f.startsWith('.github/'));
    expect(githubFiles.length).toBe(0);
  });

  it('should NOT include config/tooling (test config)', () => {
    const files = getPackFiles();
    const toolingFiles = files.filter(f => f.startsWith('config/tooling/'));
    expect(toolingFiles.length).toBe(0);
  });

  it('should NOT include Vitest config files', () => {
    const files = getPackFiles();
    const vitestFiles = files.filter(f => f.includes('vitest'));
    expect(vitestFiles.length).toBe(0);
  });

  it('should NOT include ESLint config files', () => {
    const files = getPackFiles();
    const eslintFiles = files.filter(f => f.includes('eslint'));
    expect(eslintFiles.length).toBe(0);
  });

  it('should NOT include TypeScript config files', () => {
    const files = getPackFiles();
    const tsconfigFiles = files.filter(f => f === 'tsconfig.json');
    expect(tsconfigFiles.length).toBe(0);
  });

  it('should NOT include temporary files', () => {
    const files = getPackFiles();
    const tempFiles = files.filter(f => 
      f.endsWith('.tmp') || 
      f.endsWith('.temp') || 
      f.endsWith('.log') ||
      f.endsWith('.tgz')
    );
    expect(tempFiles.length).toBe(0);
  });

  it('should NOT include .env files', () => {
    const files = getPackFiles();
    const envFiles = files.filter(f => f === '.env' || f === '.env.example');
    expect(envFiles.length).toBe(0);
  });

  it('should include main entry point', () => {
    const files = getPackFiles();
    expect(files).toContain('scripts/setup.js');
  });

  it('should have reasonable total file count', () => {
    const files = getPackFiles();
    // We expect around 100-200 files (not too many, not too few)
    expect(files.length).toBeGreaterThan(50);
    expect(files.length).toBeLessThan(500);
  });

  it('should include source files from all key modules', () => {
    const files = getPackFiles();
    
    // Check for key source files
    expect(files.some(f => f.startsWith('src/infrastructure/'))).toBe(true);
    expect(files.some(f => f.startsWith('src/orchestration/'))).toBe(true);
    expect(files.some(f => f.startsWith('src/web-research/'))).toBe(true);
    expect(files.some(f => f.startsWith('src/utils/'))).toBe(true);
    expect(files.some(f => f.startsWith('src/tui/'))).toBe(true);
    expect(files.some(f => f === 'src/index.ts')).toBe(true);
  });

  it('should NOT include package-lock.json', () => {
    const files = getPackFiles();
    expect(files.includes('package-lock.json')).toBe(false);
  });

  it('should NOT include node_modules', () => {
    const files = getPackFiles();
    const nodeModulesFiles = files.filter(f => f.includes('node_modules'));
    expect(nodeModulesFiles.length).toBe(0);
  });

  it('should NOT include CI/CD workflow files', () => {
    const files = getPackFiles();
    const workflowFiles = files.filter(f => f.startsWith('.github/') || f.includes('workflow'));
    expect(workflowFiles.length).toBe(0);
  });

  it('should NOT include .nvmrc', () => {
    const files = getPackFiles();
    expect(files.includes('.nvmrc')).toBe(false);
  });
});
