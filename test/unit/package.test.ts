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
    // Fail loudly if the manifest could not be read. Every negative assertion below
    // ("should NOT include …") is trivially satisfied by an empty list, so without
    // this guard a broken pack invocation reports as a passing packaging audit.
    if (packFiles.length < 50) {
      throw new Error(`npm pack manifest looks wrong: ${packFiles.length} file(s) parsed`);
    }
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
    // Read the manifest from `--json` rather than scraping human `npm notice` lines.
    // Those notices are written at npm's *notice* log level, so an inherited
    // `npm_config_loglevel=silent` — which `npm run <script> --silent` propagates to
    // every child process — suppresses them entirely. The scraper then produced an
    // EMPTY list, and an empty list silently satisfies every "should NOT include
    // <secrets|tests|node_modules>" assertion in this file: the packaging guarantees
    // would read as green while nothing had actually been checked.
    const output = execSync('npm pack --dry-run --json', {
      encoding: 'utf8',
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'ignore'], // drop the prepare-script build output
      maxBuffer: 32 * 1024 * 1024,
    });

    // npm pack --json changed shape across versions: npm ≤11 prints a JSON
    // ARRAY of entries, npm 12 prints a single OBJECT keyed by package name —
    // and both can carry stdout chatter around it. Extract the first complete
    // JSON value with a string/escape-aware brace/bracket scan, then normalize
    // the shape. Kept in sync with the scanner in scripts/verify-package.cjs
    // (a CJS script this ESM test cannot import).
    const objStart = output.indexOf('{');
    const arrStart = output.indexOf('[');
    const starts = [objStart, arrStart].filter((i) => i >= 0);
    if (starts.length === 0) throw new Error(`npm pack produced no JSON output: ${output.slice(0, 200)}`);
    const start = Math.min(...starts);
    const openCh = output[start];
    const closeCh = openCh === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let i = start; i < output.length; i++) {
      const ch = output[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === openCh) depth++;
      else if (ch === closeCh) {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end < 0) throw new Error('npm pack JSON was truncated');
    const parsed = JSON.parse(output.slice(start, end + 1)) as
      | Array<{ files?: Array<{ path?: string }> }>
      | Record<string, { files?: Array<{ path?: string }> }>;
    const entry = Array.isArray(parsed) ? parsed[0] : parsed[Object.keys(parsed)[0]];
    return (entry?.files ?? []).map((f) => f.path).filter((p): p is string => typeof p === 'string');
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

  /**
   * The shipped agent skill must NOT sit at a package-root `skills/` directory.
   *
   * `pi` reserves four package-root resource names (extensions, skills, prompts,
   * themes) and convention-scans any of them the package's `pi` manifest does not
   * explicitly declare. Because this package declares `extensions` only, a
   * root-level `skills/` was scanned and its SKILL.md loaded as a pi agent skill —
   * shadowing the extension's own native research tool with a slower subprocess
   * duplicate. It fired whenever anything rewrote the package's settings entry
   * into object form, which `pi config` does on ANY toggle of the package,
   * including merely disabling the extension.
   *
   * The skill therefore ships under `agent-skill/`. This pins the property that
   * actually matters (no reserved root name in the tarball) rather than the
   * specific replacement name, so renaming again stays safe but regressing to a
   * reserved name cannot pass.
   */
  const PI_RESERVED_RESOURCE_DIRS = ['extensions', 'skills', 'prompts', 'themes'];

  it.each(PI_RESERVED_RESOURCE_DIRS)(
    'must not ship a package-root %s/ directory (pi convention-scans it as a resource root)',
    (reserved) => {
      const offenders = packFiles.filter(f => f.startsWith(`${reserved}/`));
      expect(offenders).toEqual([]);
    },
  );

  it('ships the agent skill under agent-skill/, with SKILL.md and its launcher', () => {
    expect(packFiles).toContain('agent-skill/pi-research/SKILL.md');
    expect(packFiles).toContain('agent-skill/pi-research/scripts/run.mjs');
    // The TypeScript source of the launcher is built, not shipped.
    expect(packFiles).not.toContain('agent-skill/pi-research/scripts/run.ts');
  });
});

describe('package-lock.json — phantom-optional stubs survive regeneration', () => {
  // @kreuzberg/html-to-markdown-node@3.7.x lists linux-{x64,arm64}-musl in its
  // optionalDependencies, but those packages were NEVER PUBLISHED to the
  // registry (404). `npm ci`'s sync check demands a lock entry for every
  // referenced optional, and the only entry that can exist for a phantom
  // package is a bare {"optional": true} stub — NESTED under the parent
  // (node_modules/<parent>/node_modules/<musl-pkg>); a hoisted stub does NOT
  // satisfy the check (verified empirically both ways with `npm ci --dry-run`).
  //
  // Every plain lockfile regeneration (`npm install`, `--package-lock-only`;
  // npm 11.19 included) silently DROPS these stubs and breaks `npm ci` on CI
  // with `Missing: @kreuzberg/...-musl@ from lock file`. This has now happened
  // twice (2026-06-24, 2026-08-20). This test makes the constraint enforced
  // in-repo: if you regenerated the lock and landed here, re-add the two
  // nested stubs (and re-run `npm ci --dry-run` to confirm sync) before
  // pushing. Clears when kreuzberg publishes the musl variants or drops the
  // references — at that point delete this test along with the stubs.
  it('keeps the VERSIONED optional stubs for kreuzberg\'s phantom musl variants (npm 12 form)', () => {
    // HISTORY: the stubs were nested bare {"optional": true} entries under the
    // npm ≤11 lockfile; npm 12's ci rejects bare stubs ("Missing …@ from lock
    // file") AND its own `--package-lock-only` regeneration silently drops the
    // entries (the registry 404s), so every regen broke `npm ci` again. The
    // stubs are now VERSIONED top-level entries (version + resolved + optional,
    // no integrity — the 404 is skipped as an optional at install time; both
    // behaviors verified against npm 12.0.2). If this test fails after a lock
    // regeneration, re-add the two entries exactly as below before pushing.
    const lock = JSON.parse(
      fs.readFileSync(path.join(__dirname, '../../package-lock.json'), 'utf-8'),
    ) as { packages: Record<string, { optional?: boolean; version?: string }> };

    const parent = 'node_modules/@kreuzberg/html-to-markdown-node';
    for (const variant of ['linux-arm64-musl', 'linux-x64-musl']) {
      const key = `${parent}-${variant}`;
      const entry = lock.packages[key];
      expect(
        entry,
        `package-lock.json lost the stub for the UNPUBLISHED ${variant} platform package — ` +
        `npm ci will fail on CI. Re-add "${key}": { "version": "3.7.2", "resolved": "https://registry.npmjs.org/@kreuzberg/html-to-markdown-node-${variant}/-/html-to-markdown-node-${variant}-3.7.2.tgz", "optional": true } (see this test's comment).`,
      ).toBeDefined();
      expect(entry!.optional).toBe(true);
      expect(entry!.version).toBe('3.7.2');
    }
  });
});


describe('version sync across release artifacts', () => {
  // The three release gates (verify-package.cjs manifest mode, the release
  // workflow's grep, prepublishOnly) all assert package.json and SKILL.md carry
  // the same version — but they only run at release/CI time. The 1.6.6 bump was
  // made as a plain commit, SKILL.md stayed at 1.6.5, and the drift sat on the
  // branch until the release-engineering audit caught it. This is the cheap
  // local tripwire that fails `test:unit` within seconds of a version bump that
  // skipped `npm version` (which runs scripts/sync-skill-version.cjs).
  it('SKILL.md metadata version matches package.json', () => {
    const pkgVersion = JSON.parse(fs.readFileSync('package.json', 'utf-8')).version as string;
    const skill = fs.readFileSync('agent-skill/pi-research/SKILL.md', 'utf-8');
    const m = skill.match(/"version"\s*:\s*"([^"]+)"/);
    expect(m, 'SKILL.md metadata carries a version field').not.toBeNull();
    expect(m![1]).toBe(pkgVersion);
  });
});
