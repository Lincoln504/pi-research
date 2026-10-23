/**
 * Loader-context regression test.
 *
 * pi loads this extension through a transform pipeline (jiti / esbuild to CJS)
 * where `import.meta` compiles to an empty object: `import.meta.url` may be shimmed
 * but `import.meta.resolve` is undefined, so calling it throws. The old
 * `checkModule()` (web-research/utils.ts) and `isBrowserAvailable()`
 * (browser/config.ts) both called `import.meta.resolve` and swallowed the throw,
 * silently reporting installed modules as missing — which disabled the browser
 * scrape path and made every research run abort with "Browser engine not
 * installed" even with the browser present.
 *
 * This test reproduces that loader context exactly: it bundles the REAL source
 * modules to CJS with the repo's esbuild (the same compiler family pi uses),
 * requires the bundles, and asserts the availability checks still work. Both
 * assertions fail against the pre-fix code (the CJS bundle reports
 * camoufox/playwright-core as missing and the browser as not installed).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import * as esbuild from 'esbuild';

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const bundleDir = path.join(__dirname, 'cjs-bundles');

async function bundleToCjs(source: string, outFile: string): Promise<void> {
  // The esbuild JS API (not the CLI): it locates and spawns the platform
  // native binary itself, so it works identically on Linux, macOS and
  // Windows (the .bin shim is a .cmd on Windows, which spawnSync cannot
  // execute directly).
  const result = await esbuild.build({
    entryPoints: [source],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: outFile,
    external: ['node:*'],
  });
  if (result.errors.length > 0) {
    throw new Error(`esbuild failed for ${source}:\n${JSON.stringify(result.errors)}`);
  }
  // Reproduce pi's actual loader (jiti) exactly: jiti's CJS output shims
  // `import.meta.url` (to the file's own URL) but NOT `import.meta.resolve`
  // (stays undefined). esbuild's bare CJS output shims neither, so patch the
  // compiled `import_meta` objects to carry only `url` — the precise pi
  // context in which the pre-fix code failed.
  const src = fs.readFileSync(outFile, 'utf-8');
  const patched = src.replace(
    /(var import_meta\d* = )\{\};/g,
    '$1{ url: require("node:url").pathToFileURL(__filename).toString() };',
  );
  fs.writeFileSync(outFile, patched);
}

describe('CJS loader context (pi transform pipeline)', () => {
  const require = createRequire(import.meta.url);

  beforeAll(() => {
    fs.rmSync(bundleDir, { recursive: true, force: true });
    fs.mkdirSync(bundleDir, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(bundleDir, { recursive: true, force: true });
  });

  it('checkModule resolves installed packages from the CJS bundle', async () => {
    await bundleToCjs(path.join(repoRoot, 'src/web-research/utils.ts'), path.join(bundleDir, 'utils.cjs'));
    const mod = require(path.join(bundleDir, 'utils.cjs')) as { checkModule: (name: string) => boolean };
    // Both are direct dependencies of this package: resolvable from any file
    // inside the repo tree. The pre-fix code returned false for both here
    // (import.meta.resolve undefined in CJS output).
    expect(mod.checkModule('camoufox')).toBe(true);
    expect(mod.checkModule('playwright-core')).toBe(true);
    // A package that is NOT installed must still report false.
    expect(mod.checkModule('definitely-not-a-real-package-xyz')).toBe(false);
  });

  it('isBrowserAvailable reports an installed browser from the CJS bundle', async () => {
    // Build the exact installed layout in the sandboxed unit HOME: the compat
    // flag plus the paired build (pin from browser-pin.json: official
    // 156.0.1 beta.36). The directory hash is not part of the pin match.
    await bundleToCjs(path.join(repoRoot, 'src/infrastructure/browser/config.ts'), path.join(bundleDir, 'config.cjs'));
    const mod = require(path.join(bundleDir, 'config.cjs')) as {
      isBrowserAvailable: () => boolean;
      getCamoufoxBinaryPath: () => string;
    };
    // The cache directory the module ITSELF computes (platform-specific: XDG on
    // Linux, ~/Library on macOS, %LOCALAPPDATA% on Windows — the unit env
    // sandboxes all of those). Never hard-code the Linux layout here: the
    // pre-fix failure mode is a path mismatch, and this test must not
    // reproduce one.
    const cacheDir = mod.getCamoufoxBinaryPath();
    fs.rmSync(cacheDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(cacheDir, 'browsers', 'official'), { recursive: true });
    fs.writeFileSync(path.join(cacheDir, '.0.5_FLAG'), '');
    const installDir = path.join(cacheDir, 'browsers', 'official', '156.0.1-beta.36-00000000');
    fs.mkdirSync(installDir, { recursive: true });
    // listInstalls() requires a version.json per install dir (the real
    // camoufox fetch writes it); a bare directory is skipped, as the library
    // skips one too.
    fs.writeFileSync(path.join(installDir, 'version.json'), JSON.stringify({ version: '156.0.1', build: 'beta.36' }));

    // Pre-fix: false (import.meta.resolve threw in the CJS bundle).
    expect(mod.isBrowserAvailable()).toBe(true);

    // Negative control: without the compat flag the layout is unusable, so the
    // check must stay false (guards against a vacuous always-true test).
    fs.rmSync(path.join(cacheDir, '.0.5_FLAG'));
    expect(mod.isBrowserAvailable()).toBe(false);
  });
});
