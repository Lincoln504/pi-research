#!/usr/bin/env node

/**
 * Verifies the npm-install delivery path — robustly and thoroughly.
 *
 * Two modes:
 *
 *   node scripts/verify-package.cjs manifest
 *     Inspects the tarball npm WOULD publish (`npm pack --dry-run --json`) and
 *     asserts every required file is present and no junk leaked in. Run AFTER
 *     `npm run build:worker && npm run build:openclaw` so the bundled artifacts
 *     exist. Uses --ignore-scripts so the prepare lifecycle's stdout does not
 *     corrupt the JSON (and because the build already ran).
 *
 *   node scripts/verify-package.cjs installed <packageDir>
 *     Inspects a REAL installed package directory (e.g.
 *     node_modules/@lincoln504/pi-research after `npm install <tarball>`) and
 *     asserts every critical runtime file exists on disk and every `exports`
 *     subpath target resolves to a real file.
 *
 * Exits non-zero with an actionable message on the first failure.
 */

'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Files/globs the published package MUST contain. Globs use a trailing
// "/*.md (>=N)" convention checked below.
const REQUIRED = [
  'package.json',
  'README.md',
  'LICENSE',
  'openclaw.plugin.json',
  // Entry points (also cross-checked against package.json "exports")
  'src/index.ts',
  'src/sdk.ts',
  'src/openclaw-entry.ts',
  // Bundled runtime artifacts — the git-install + openclaw paths run off these,
  // and the worker .mjs is what FixedClusterPool spawns.
  'src/infrastructure/browser/thread-worker.mjs',
  'dist/openclaw-entry.js',
  'dist/thread-worker.mjs',
  // CLI binary (the `pi-research` bin in package.json)
  'dist/cli.mjs',
  // Agent skill — the launcher + definition that coding agents load
  'skills/research/SKILL.md',
  'skills/research/scripts/run.mjs',
  // Install/uninstall lifecycle scripts
  'scripts/setup.cjs',
  'scripts/cleanup.cjs',
];

// Prompt templates must ship in BOTH locations (src tree for the pi extension,
// dist for the bundled openclaw plugin).
const PROMPT_DIRS = [
  { dir: 'src/prompts', min: 5 },
  { dir: 'dist/prompts', min: 5 },
];

// Patterns that must NEVER appear in the published tarball.
const FORBIDDEN = [
  { re: /\.test\.[cm]?[jt]sx?$/, what: 'test files' },
  { re: /\.spec\.[cm]?[jt]sx?$/, what: 'spec files' },
  { re: /(^|\/)test\//, what: 'test/ directory' },
  { re: /(^|\/)\.env/, what: '.env files' },
  { re: /node_modules\//, what: 'nested node_modules' },
  { re: /\.map$/, what: 'source maps' },
  { re: /\.tsbuildinfo$/, what: 'tsbuildinfo' },
  { re: /(^|\/)tsconfig.*\.json$/, what: 'tsconfig files' },
];

function fail(msg) {
  console.error(`❌ ${msg}`);
  process.exitCode = 1;
}

function exportsTargets() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const out = [];
  for (const v of Object.values(pkg.exports || {})) {
    const target = typeof v === 'string' ? v : v && v.default;
    if (typeof target === 'string') out.push(target.replace(/^\.\//, ''));
  }
  return out;
}

function verifyManifest() {
  let raw;
  try {
    raw = execSync('npm pack --dry-run --json --ignore-scripts', {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (e) {
    fail(`npm pack --dry-run failed: ${e.message}`);
    return;
  }

  // npm pack --json prints a JSON array to stdout, but on some npm versions the
  // `prepare` lifecycle still runs during `npm pack` even with --ignore-scripts,
  // emitting build progress text BEFORE the JSON. Slice from the first '[' so we
  // parse only the JSON array regardless of any leading chatter.
  const jsonStart = raw.indexOf('[');
  if (jsonStart < 0) {
    fail(`npm pack produced no JSON output. Got: ${raw.slice(0, 200)}`);
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(jsonStart));
  } catch (e) {
    fail(`could not parse npm pack JSON: ${e.message}`);
    return;
  }
  const files = parsed[0].files.map((f) => f.path);
  const set = new Set(files);

  for (const req of REQUIRED) {
    if (!set.has(req)) fail(`Missing from published tarball: ${req}`);
  }

  // Every exports target must be in the tarball.
  for (const t of exportsTargets()) {
    if (t !== 'package.json' && !set.has(t)) fail(`exports target not shipped: ${t}`);
  }

  for (const { dir, min } of PROMPT_DIRS) {
    const n = files.filter((p) => p.startsWith(`${dir}/`) && p.endsWith('.md')).length;
    if (n < min) fail(`${dir}: expected >=${min} .md prompt files, found ${n}`);
  }

  for (const f of files) {
    for (const { re, what } of FORBIDDEN) {
      if (re.test(f)) fail(`Forbidden ${what} leaked into tarball: ${f}`);
    }
  }

  if (process.exitCode) {
    console.error(`\nManifest verification FAILED (${files.length} files inspected).`);
  } else {
    console.log(`✅ Tarball manifest verified: ${files.length} files, all required present, no junk.`);
  }
}

function verifyInstalled(pkgDir) {
  if (!pkgDir || !fs.existsSync(pkgDir)) {
    fail(`installed package dir not found: ${pkgDir}`);
    return;
  }

  const need = [...REQUIRED];
  for (const { dir, min } of PROMPT_DIRS) {
    let n = 0;
    const full = path.join(pkgDir, dir);
    if (fs.existsSync(full)) n = fs.readdirSync(full).filter((f) => f.endsWith('.md')).length;
    if (n < min) fail(`${dir}: expected >=${min} .md files in installed package, found ${n}`);
  }

  for (const rel of need) {
    if (!fs.existsSync(path.join(pkgDir, rel))) fail(`Missing from installed package: ${rel}`);
  }

  // exports targets must resolve to real files on disk in the installed package.
  for (const t of exportsTargets()) {
    if (!fs.existsSync(path.join(pkgDir, t))) fail(`Installed exports target missing: ${t}`);
  }

  // Executable scripts MUST start with a shebang. npm relies on it (not the exec
  // bit) to run a `bin` on Linux/macOS; an esbuild bundle has none unless the
  // build adds a --banner. Without it `pi-research` fails with an exec-format
  // error on Unix, while Windows' generated shims hide the breakage — so assert
  // it here where the file content is on disk.
  const SHEBANG = '#!/usr/bin/env node';
  for (const rel of ['dist/cli.mjs', 'skills/research/scripts/run.mjs']) {
    const full = path.join(pkgDir, rel);
    if (!fs.existsSync(full)) continue; // already reported missing above
    const firstLine = fs.readFileSync(full, 'utf8').split('\n', 1)[0];
    if (firstLine !== SHEBANG) {
      fail(`Executable ${rel} is missing the '${SHEBANG}' shebang (first line: ${JSON.stringify(firstLine)}). It will not run as a bin on Linux/macOS.`);
    }
  }

  if (process.exitCode) {
    console.error('\nInstalled-package verification FAILED.');
  } else {
    console.log(`✅ Installed package verified at ${pkgDir}: all entry points, bundles, worker, and prompts present.`);
  }
}

const mode = process.argv[2];
if (mode === 'manifest') {
  verifyManifest();
} else if (mode === 'installed') {
  verifyInstalled(process.argv[3]);
} else {
  console.error('Usage: verify-package.cjs <manifest | installed <packageDir>>');
  process.exitCode = 2;
}
