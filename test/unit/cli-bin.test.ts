/**
 * Unit tests for the installed `pi-research` bin shim (src/cli-bin.mjs) and for
 * the packaging invariants that keep it reachable.
 *
 * The shim exists for one failure: an install that skipped peer dependencies
 * (`npm install --legacy-peer-deps`, yarn classic, pnpm with
 * auto-install-peers=false) leaves `@earendil-works/pi-*` absent, and the bundle
 * then dies at module load with a raw ERR_MODULE_NOT_FOUND. Because esbuild
 * hoists the bundle's external imports to the top of dist/cli.mjs, the check
 * cannot live inside the bundle — it has to be a separate module that runs
 * first, which is what these tests pin.
 *
 * The shim also has to fix up `process.argv[1]`: dist/cli.mjs runs its main()
 * only when argv[1] resolves to its own module file, and argv[1] is the shim.
 * A shim that omitted that rewrite would exit 0 having done nothing at all,
 * which is why the stub CLI below asserts the contract instead of just echoing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.join(fileURLToPath(import.meta.url), '..', '..', '..');
const SHIM_SOURCE = path.join(REPO, 'src', 'cli-bin.mjs');

/** A stub engine that asserts the argv[1] contract the shim must satisfy. */
const STUB_CLI = `
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const modulePath = realpathSync(fileURLToPath(import.meta.url));
const invokedPath = realpathSync(process.argv[1]);
if (modulePath !== invokedPath) {
  console.error('ARGV1_CONTRACT_VIOLATED: argv[1]=' + process.argv[1]);
  process.exit(97);
}
console.log('engine ran with args: ' + process.argv.slice(2).join(','));
`;

function hostPackage(dir: string, name: string): void {
  const pkgDir = path.join(dir, 'node_modules', ...name.split('/'));
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({
      name,
      version: '0.0.0',
      type: 'module',
      // ESM-only exports, like the real host packages. This matters: the shim
      // deliberately uses import.meta.resolve() rather than createRequire, which
      // would report ERR_PACKAGE_PATH_NOT_EXPORTED for a present package here.
      exports: { '.': { import: './index.js' } },
    }),
  );
  writeFileSync(path.join(pkgDir, 'index.js'), 'export const host = true;\n');
}

describe('pi-research bin shim', () => {
  let workDir: string;
  let shim: string;

  beforeAll(() => {
    workDir = mkdtempSync(path.join(tmpdir(), 'pi-research-bin-'));
    mkdirSync(path.join(workDir, 'dist'), { recursive: true });
    shim = path.join(workDir, 'dist', 'cli-bin.mjs');
    copyFileSync(SHIM_SOURCE, shim);
    writeFileSync(path.join(workDir, 'dist', 'cli.mjs'), STUB_CLI);
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  function runShim(args: string[] = []): { status: number | null; stdout: string; stderr: string } {
    const r = spawnSync(process.execPath, [shim, ...args], {
      encoding: 'utf-8',
      cwd: workDir,
      timeout: 20_000,
    });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  }

  it('exits 78 with the install remedy — not a stack trace — when peers are missing', () => {
    rmSync(path.join(workDir, 'node_modules'), { recursive: true, force: true });
    const r = runShim(['status']);

    expect(r.status).toBe(78);
    expect(r.stderr).toContain('@earendil-works/pi-ai');
    expect(r.stderr).toContain('@earendil-works/pi-coding-agent');
    // The remedy must name BOTH when both are missing. It used to hardcode a
    // single package name, so the "add just the missing host package" line
    // installed one of the two and left the install still broken.
    expect(r.stderr).toContain(
      'npm install -g @earendil-works/pi-ai @earendil-works/pi-coding-agent',
    );
    expect(r.stderr).not.toContain('ERR_MODULE_NOT_FOUND');
    expect(r.stdout).not.toContain('engine ran');
  });

  it('names only the package that is actually missing', () => {
    rmSync(path.join(workDir, 'node_modules'), { recursive: true, force: true });
    hostPackage(workDir, '@earendil-works/pi-ai');
    const r = runShim();

    expect(r.status).toBe(78);
    expect(r.stderr).toContain('@earendil-works/pi-coding-agent');
    expect(r.stderr).not.toContain('    @earendil-works/pi-ai');
  });

  it('the remedy names the package that is missing, not the one that is present', () => {
    // The precise case that was broken: pi-ai absent, pi-coding-agent present.
    // The remedy used to read `npm install -g @earendil-works/pi-coding-agent`,
    // i.e. install the package the user already had, which fixes nothing.
    rmSync(path.join(workDir, 'node_modules'), { recursive: true, force: true });
    hostPackage(workDir, '@earendil-works/pi-coding-agent');
    const r = runShim();

    expect(r.status).toBe(78);
    expect(r.stderr).toMatch(/npm install -g @earendil-works\/pi-ai(\s|$)/);
    expect(r.stderr).not.toContain('npm install -g @earendil-works/pi-coding-agent');
  });

  it('also guards pi-tui, which dist/cli.mjs imports directly', () => {
    rmSync(path.join(workDir, 'node_modules'), { recursive: true, force: true });
    hostPackage(workDir, '@earendil-works/pi-ai');
    hostPackage(workDir, '@earendil-works/pi-coding-agent');
    const r = runShim();

    expect(r.status).toBe(78);
    expect(r.stderr).toMatch(/npm install -g @earendil-works\/pi-tui(\s|$)/);
    expect(r.stdout).not.toContain('engine ran');
  });

  it('also guards typebox, a peer dependency that dist/cli.mjs imports directly', () => {
    rmSync(path.join(workDir, 'node_modules'), { recursive: true, force: true });
    hostPackage(workDir, '@earendil-works/pi-ai');
    hostPackage(workDir, '@earendil-works/pi-coding-agent');
    hostPackage(workDir, '@earendil-works/pi-tui');
    const r = runShim();

    expect(r.status).toBe(78);
    expect(r.stderr).toMatch(/npm install -g typebox(\s|$)/);
    expect(r.stdout).not.toContain('engine ran');
  });

  it('reports a package whose files are incomplete, instead of passing it and crashing later', () => {
    // Resolving is not loading. An interrupted install or a pruned node_modules
    // leaves package.json and its exports map intact while the file they point
    // at is gone: the old preflight saw a successful resolve, waved it through,
    // and cli.mjs then died with the raw ERR_MODULE_NOT_FOUND this shim exists
    // to replace.
    rmSync(path.join(workDir, 'node_modules'), { recursive: true, force: true });
    hostPackage(workDir, '@earendil-works/pi-coding-agent');
    hostPackage(workDir, '@earendil-works/pi-ai');
    hostPackage(workDir, '@earendil-works/pi-tui');
    hostPackage(workDir, 'typebox');
    rmSync(path.join(workDir, 'node_modules', '@earendil-works', 'pi-ai', 'index.js'));
    const r = runShim();

    expect(r.status).toBe(78);
    expect(r.stderr).toContain('@earendil-works/pi-ai  (installed, but its files are incomplete)');
    expect(r.stderr).toContain('npm install -g @earendil-works/pi-ai');
    expect(r.stderr).not.toContain('ERROR');
    expect(r.stdout).not.toContain('engine ran');
  });

  it('loads the bundle when both peers are present, and rewrites argv[1] so main() runs', () => {
    hostPackage(workDir, '@earendil-works/pi-ai');
    hostPackage(workDir, '@earendil-works/pi-coding-agent');
    hostPackage(workDir, '@earendil-works/pi-tui');
    hostPackage(workDir, 'typebox');
    const r = runShim(['--version']);

    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    // The stub exits 97 if argv[1] still points at the shim.
    expect(r.stdout).toContain('engine ran with args: --version');
    expect(r.stdout).not.toContain('ARGV1_CONTRACT_VIOLATED');
  });

  it('resolves peers with ESM conditions, so a present package is never reported missing', () => {
    // Regression guard for the createRequire trap: ESM-only exports maps make the
    // CJS resolver throw ERR_PACKAGE_PATH_NOT_EXPORTED for an installed package.
    hostPackage(workDir, '@earendil-works/pi-ai');
    hostPackage(workDir, '@earendil-works/pi-coding-agent');
    hostPackage(workDir, '@earendil-works/pi-tui');
    hostPackage(workDir, 'typebox');
    const r = runShim();
    expect(r.stdout).toContain('engine ran');
  });
});

describe('bin packaging invariants', () => {
  const pkg = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8')) as {
    bin: Record<string, string>;
    files: string[];
  };

  it('points bin at the shim, not at the bundle', () => {
    expect(pkg.bin['pi-research']).toBe('./dist/cli-bin.mjs');
  });

  it('ships both the shim and the bundle it loads', () => {
    expect(pkg.files).toContain('dist/cli-bin.mjs');
    expect(pkg.files).toContain('dist/cli.mjs');
  });

  it('ships the shim unbundled, with the shebang npm needs on Linux and macOS', () => {
    const source = readFileSync(SHIM_SOURCE, 'utf8');
    expect(source.split('\n')[0].replace(/\r$/, '')).toBe('#!/usr/bin/env node');
    // If the shim were ever folded into the bundle it could not run first.
    expect(source).toContain("await import('./cli.mjs')");
  });
});
