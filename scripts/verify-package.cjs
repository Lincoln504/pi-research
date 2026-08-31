#!/usr/bin/env node

/**
 * Verifies the npm-install delivery path — robustly and thoroughly.
 *
 * Two modes:
 *
 *   node scripts/verify-package.cjs manifest
 *     Inspects the tarball npm WOULD publish (`npm pack --dry-run --json`) and
 *     asserts every required file is present and no junk leaked in. Run AFTER
 *     `npm run build:worker && npm run build:cli` so the bundled artifacts
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
  // Entry points (also cross-checked against package.json "exports")
  'src/index.ts',
  'src/sdk.ts',
  // Bundled runtime artifacts — the CLI/skill engine runs off these, and the
  // worker .mjs is what FixedClusterPool spawns.
  'src/infrastructure/browser/thread-worker.mjs',
  'dist/thread-worker.mjs',
  // PDF worker bundle pair — a dropped copy step would ship a package where
  // PDF extraction silently regresses to main-thread parsing (graceful
  // fallback, no error), so the manifest gate is the only place that catches it.
  'src/web-research/pdf-extract-worker.mjs',
  'dist/pdf-extract-worker.mjs',
  // CLI binary (the `pi-research` bin in package.json)
  'dist/cli.mjs',
  // Out-of-process WebGPU viability probe (cli.mjs spawns it; shipped via files[])
  'dist/webgpu-probe.mjs',
  // Agent skill — the launcher + definition that coding agents load
  'agent-skill/pi-research/SKILL.md',
  'agent-skill/pi-research/scripts/run.mjs',
  // Referenced by SKILL.md ("Full reference: references/configuration.md")
  'agent-skill/pi-research/references/configuration.md',
  // Install/uninstall lifecycle scripts
  'scripts/setup.cjs',
  'scripts/cleanup.cjs',
  // Build scripts the git-install path depends on: `prepare` runs on install and
  // invokes build.cjs to produce dist/ + the skill launcher from source. Dropping
  // either from files[] would silently break `pi install git:` / directory installs.
  'scripts/build.cjs',
  'scripts/prepare.cjs',
];

// Prompt templates must ship in BOTH locations (src tree for the pi extension,
// dist for the bundled CLI/skill engine, which resolves prompts next to its bundle).
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
  console.error(`ERROR: ${msg}`);
  process.exitCode = 1;
}

/**
 * dist/prompts must be a byte-exact copy of src/prompts.
 *
 * The count check above only proves files EXIST. But dist/prompts is what the
 * bundled CLI and the agent-skill engine actually load (loadPrompt resolves
 * next to the bundle), so a stale copy means the shipped product runs on
 * different instructions than the source tree says it does — with every gate
 * green, because the file count is unchanged. Editing a prompt without
 * rebuilding produces exactly that, and it is invisible: the CLI keeps serving
 * the old text. A truncated or partially-written copy fails here too.
 *
 * Compared on disk in the working tree (not the tarball) because that is where
 * the drift happens; `prepublishOnly` rebuilds before packing, so a publish is
 * only ever as fresh as this check makes the tree.
 */
function verifyPromptsInSync() {
  const srcDir = path.join(ROOT, 'src', 'prompts');
  const distDir = path.join(ROOT, 'dist', 'prompts');
  if (!fs.existsSync(srcDir) || !fs.existsSync(distDir)) return; // nothing built yet
  const srcFiles = fs.readdirSync(srcDir).filter((f) => f.endsWith('.md')).sort();
  const distFiles = fs.readdirSync(distDir).filter((f) => f.endsWith('.md')).sort();
  for (const f of srcFiles) {
    if (!distFiles.includes(f)) {
      fail(`dist/prompts is missing ${f} — run \`npm run build\` (the bundled CLI loads dist/prompts, not src/prompts).`);
      continue;
    }
    const a = fs.readFileSync(path.join(srcDir, f));
    const b = fs.readFileSync(path.join(distDir, f));
    if (!a.equals(b)) {
      fail(`dist/prompts/${f} is STALE (differs from src/prompts/${f}) — run \`npm run build\`. The shipped CLI would run the old prompt.`);
    }
  }
  for (const f of distFiles) {
    if (!srcFiles.includes(f)) fail(`dist/prompts/${f} has no counterpart in src/prompts — remove it or rebuild.`);
  }
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

// The package version is duplicated in two hand-maintained places. The `npm
// version` lifecycle syncs them, but a manual edit can drift them silently —
// shipping a skill that disagrees with package.json. Assert equality so a drift
// fails the publish gate instead of reaching users.
function verifyVersionSync() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const skillMd = fs.readFileSync(path.join(ROOT, 'agent-skill/pi-research/SKILL.md'), 'utf8');
  const skillMatch = skillMd.match(/"version":\s*"([^"]+)"/);
  const skillVersion = skillMatch ? skillMatch[1] : null;

  if (skillVersion !== pkg.version) {
    fail(`agent-skill/pi-research/SKILL.md version (${skillVersion}) != package.json version (${pkg.version}). Run \`npm version\` or sync manually.`);
  }
  if (!process.exitCode) {
    console.log(`OK: version ${pkg.version} consistent across package.json and SKILL.md.`);
  }
}

function verifyManifest() {
  verifyVersionSync();

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

  // npm pack --json prints a JSON array to stdout, but npm versions differ in
  // the chatter they put around it: some emit prepare/build text BEFORE the
  // JSON, and npm 12 can emit content AFTER it (observed on CI: "Unexpected
  // non-whitespace character after JSON"). Slice out exactly the first
  // complete JSON array with a string/escape-aware bracket scan, so both
  // leading and trailing chatter are ignored on every npm version.
  const jsonStart = raw.indexOf('[');
  if (jsonStart < 0) {
    fail(`npm pack produced no JSON output. Got: ${raw.slice(0, 200)}`);
    return;
  }
  let jsonEnd = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = jsonStart; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) { jsonEnd = i; break; }
    }
  }
  if (jsonEnd < 0) {
    fail(`npm pack JSON was truncated. Got: ${raw.slice(jsonStart, jsonStart + 200)}…`);
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
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

  verifyPromptsInSync();

  for (const f of files) {
    for (const { re, what } of FORBIDDEN) {
      if (re.test(f)) fail(`Forbidden ${what} leaked into tarball: ${f}`);
    }
  }

  if (process.exitCode) {
    console.error(`\nManifest verification FAILED (${files.length} files inspected).`);
  } else {
    console.log(`OK: Tarball manifest verified: ${files.length} files, all required present, no junk.`);
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
  for (const rel of ['dist/cli.mjs', 'agent-skill/pi-research/scripts/run.mjs']) {
    const full = path.join(pkgDir, rel);
    if (!fs.existsSync(full)) continue; // already reported missing above
    // Strip a trailing \r: a CRLF checkout (or a Windows-side pack) would otherwise fail
    // this on a shebang that is perfectly valid.
    const firstLine = fs.readFileSync(full, 'utf8').split('\n', 1)[0].replace(/\r$/, '');
    if (firstLine !== SHEBANG) {
      fail(`Executable ${rel} is missing the '${SHEBANG}' shebang (first line: ${JSON.stringify(firstLine)}). It will not run as a bin on Linux/macOS.`);
    }
  }

  if (process.exitCode) {
    console.error('\nInstalled-package verification FAILED.');
  } else {
    console.log(`OK: Installed package verified at ${pkgDir}: all entry points, bundles, worker, and prompts present.`);
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
