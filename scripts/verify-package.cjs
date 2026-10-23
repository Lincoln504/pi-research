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

const { execSync, execFileSync } = require('child_process');
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
  // The bin shim package.json actually points at. It must ship UNBUNDLED and
  // NEXT TO dist/cli.mjs: it preflights the peer dependencies the bundle imports
  // statically, and only then loads the bundle. A missing shim means `bin`
  // resolves to nothing, so npm installs a command that does not exist.
  'dist/cli-bin.mjs',
  // The shim's peer-dependency fallback (imported next to it; without them the shim itself
  // fails to load, before it can print anything).
  'dist/host-roots.mjs',
  'dist/host-resolve-hook.mjs',
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
  // Required by BOTH of the above (`require('./camoufox-layout.cjs')`): without it the
  // shipped postinstall and cleanup die with MODULE_NOT_FOUND on every install.
  'scripts/camoufox-layout.cjs',
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

// The `bin` map's targets. Checked the same way as `exports` targets because the
// failure mode is worse: a bin that is not in the tarball still installs, and npm
// happily writes a shim that resolves to a file that does not exist — so every
// user's `pi-research` command is broken, including on platforms where the shim
// is the only entry point (Windows .cmd/.ps1).
function binTargets() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const bin = pkg.bin;
  const values = typeof bin === 'string' ? [bin] : Object.values(bin || {});
  return values
    .filter((v) => typeof v === 'string')
    .map((v) => v.replace(/^\.\//, ''));
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

  // --ignore-scripts skips the prepack lifecycle, so run the LanceDB bundle strip explicitly:
  // without it npm bundles this machine's native binding into the listing (~78 MB).
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'prepack-lancedb.cjs')], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
  } catch (e) {
    fail(`scripts/prepack-lancedb.cjs failed: ${e.message}`);
    return;
  }

  let raw;
  try {
    raw = execSync('npm pack --dry-run --json --ignore-scripts', {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      // The bundled dependencies add ~700 entries to the listing; the 1 MB default overflows.
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    fail(`npm pack --dry-run failed: ${e.message}`);
    return;
  }

  // npm pack --json changed shape across versions: npm ≤11 prints a JSON ARRAY
  // of entries, npm 12 prints a single OBJECT keyed by package name — and both
  // can carry chatter before/after (observed on CI: "Unexpected non-whitespace
  // character after JSON"). Extract the first complete JSON value (object or
  // array) with a string/escape-aware brace/bracket scan, then normalize the
  // shape to the entry.
  const objStart = raw.indexOf('{');
  const arrStart = raw.indexOf('[');
  const jsonStart = (objStart < 0) ? arrStart : (arrStart < 0) ? objStart : Math.min(objStart, arrStart);
  if (jsonStart < 0) {
    fail(`npm pack produced no JSON output. Got: ${raw.slice(0, 200)}`);
    return;
  }
  const openCh = raw[jsonStart];
  const closeCh = openCh === '{' ? '}' : ']';
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
    else if (ch === openCh) depth++;
    else if (ch === closeCh) {
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
  const entry = Array.isArray(parsed) ? parsed[0] : parsed[Object.keys(parsed)[0]];
  const files = (entry?.files ?? []).map((f) => f.path);
  const set = new Set(files);

  for (const req of REQUIRED) {
    if (!set.has(req)) fail(`Missing from published tarball: ${req}`);
  }

  // LanceDB is shipped INSIDE the tarball (scripts/prepack-lancedb.cjs) so consumers never
  // resolve its optional @huggingface/transformers 3.0.2 / sharp 0.33.5 chain. Three ways
  // this silently regresses, each caught here: the bundle is dropped (consumers get the
  // registry copy and the vulnerable chain back), the optional edges are not stripped (same),
  // or a native binding gets bundled (a ~200 MB .node file for one platform).
  const bundled = new Set(entry?.bundled ?? []);
  for (const dep of ['@lancedb/lancedb', '@opentelemetry/api', 'reflect-metadata']) {
    if (!bundled.has(dep)) fail(`${dep} is not bundled into the tarball (bundleDependencies / scripts/prepack-lancedb.cjs).`);
  }
  for (const b of bundled) {
    if (/^@lancedb\/lancedb-/.test(b)) fail(`native binding ${b} was bundled into the tarball; it must resolve per platform from the registry.`);
  }
  if (typeof entry?.size === 'number' && entry.size > 8 * 1024 * 1024) {
    fail(`tarball is ${(entry.size / 1048576).toFixed(1)} MB; something large was bundled (expected < 8 MB).`);
  }
  try {
    const w = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules/@lancedb/lancedb/package.json'), 'utf8'));
    if (w.optionalDependencies) fail('the bundled @lancedb/lancedb still declares optionalDependencies (prepack-lancedb.cjs did not run).');
  } catch (e) {
    fail(`cannot read the bundled @lancedb/lancedb manifest: ${e.message}`);
  }

  // Every exports target must be in the tarball.
  for (const t of exportsTargets()) {
    if (t !== 'package.json' && !set.has(t)) fail(`exports target not shipped: ${t}`);
  }

  for (const t of binTargets()) {
    if (!set.has(t)) fail(`bin target not shipped: ${t} (the installed 'pi-research' command would not exist)`);
  }

  for (const { dir, min } of PROMPT_DIRS) {
    const n = files.filter((p) => p.startsWith(`${dir}/`) && p.endsWith('.md')).length;
    if (n < min) fail(`${dir}: expected >=${min} .md prompt files, found ${n}`);
  }

  verifyPromptsInSync();
  verifyLocalRequiresShipped(files);
  verifyWorkerBundlesSelfSufficient(ROOT);

  for (const f of files) {
    // Files of a deliberately bundled dependency are third-party content, checked above.
    if ([...bundled].some((d) => f.startsWith(`node_modules/${d}/`))) continue;
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

/**
 * A shipped script must not require a LOCAL file the tarball omits.
 *
 * `scripts/setup.cjs` and `scripts/cleanup.cjs` are shipped through files[] one by one,
 * so a helper they gain (camoufox-layout.cjs) is silently absent from the published
 * package unless files[] is updated too, and the failure only appears on a user's machine
 * as MODULE_NOT_FOUND at postinstall. Scan every shipped scripts/*.cjs for relative
 * `require('./x')` and assert each target is in the tarball.
 */
function verifyLocalRequiresShipped(shipped) {
  const set = new Set(shipped);
  for (const f of shipped) {
    if (!/^scripts\/[^/]+\.cjs$/.test(f)) continue;
    const abs = path.join(ROOT, f);
    if (!fs.existsSync(abs)) continue;
    const src = fs.readFileSync(abs, 'utf8');
    for (const m of src.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1]));
      const candidates = [target, `${target}.js`, `${target}.cjs`, `${target}.json`];
      if (!candidates.some((c) => set.has(c))) {
        fail(`${f} requires ${m[1]} but ${target} is not in the published tarball — add it to package.json files[].`);
      }
    }
  }
}

/**
 * The worker bundles run as plain Node processes and must resolve every bare import from
 * the installed package's own dependencies — never from a peer, which `pi install`
 * (--legacy-peer-deps) does not install. See scripts/bare-imports.cjs. Statically scans
 * the bundles in `dir`, then actually STARTS each standalone: a worker that cannot import
 * its dependencies exits 1 with ERR_MODULE_NOT_FOUND, exactly how v1.7.9-v1.7.18 broke.
 */
function verifyWorkerBundlesSelfSufficient(dir, { run = false } = {}) {
  const { unresolvableImports } = require('./bare-imports.cjs');
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  for (const { file, name } of unresolvableImports(dir, pkg)) {
    fail(`${file} imports "${name}", which is not an installed dependency (peers are not installed by pi install --legacy-peer-deps): the worker would die at import. Bundle it (scripts/build.cjs) or make it a dependency.`);
  }
  if (!run) return;
  const { spawnSync } = require('child_process');
  for (const rel of ['dist/thread-worker.mjs', 'dist/pdf-extract-worker.mjs']) {
    if (!fs.existsSync(path.join(dir, rel))) continue;
    const r = spawnSync(process.execPath, [path.join(dir, rel)], { cwd: dir, encoding: 'utf8', timeout: 20000 });
    if (r.status !== 0 || /ERR_MODULE_NOT_FOUND|Cannot find (package|module)/.test(r.stderr || '')) {
      fail(`${rel} does not start standalone (exit ${r.status}): ${(r.stderr || '').split('\n').find((l) => /Error|Cannot find/.test(l)) ?? ''}`);
    }
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

  for (const t of binTargets()) {
    if (!fs.existsSync(path.join(pkgDir, t))) fail(`Installed bin target missing: ${t}`);
  }

  // The bundled LanceDB wrapper must be the stripped copy, and a native binding for THIS
  // platform must have been installed beside it (the wrapper no longer pulls it in itself).
  verifyWorkerBundlesSelfSufficient(pkgDir, { run: true });

  const bundledWrapper = path.join(pkgDir, 'node_modules', '@lancedb', 'lancedb', 'package.json');
  if (!fs.existsSync(bundledWrapper)) {
    fail('Installed package has no bundled @lancedb/lancedb.');
  } else if (JSON.parse(fs.readFileSync(bundledWrapper, 'utf8')).optionalDependencies) {
    fail('Installed bundled @lancedb/lancedb still declares optionalDependencies.');
  }
  const hoisted = path.join(pkgDir, '..', '..', '@lancedb');
  const nested = path.join(pkgDir, 'node_modules', '@lancedb');
  const bindings = [hoisted, nested].flatMap((d) => (fs.existsSync(d) ? fs.readdirSync(d) : []))
    .filter((n) => /^lancedb-/.test(n));
  if (bindings.length === 0) fail('No @lancedb/lancedb-<platform> native binding was installed beside the bundled wrapper.');

  // Executable scripts MUST start with a shebang. npm relies on it (not the exec
  // bit) to run a `bin` on Linux/macOS; an esbuild bundle has none unless the
  // build adds a --banner. Without it `pi-research` fails with an exec-format
  // error on Unix, while Windows' generated shims hide the breakage — so assert
  // it here where the file content is on disk.
  const SHEBANG = '#!/usr/bin/env node';
  for (const rel of ['dist/cli.mjs', 'dist/cli-bin.mjs', 'agent-skill/pi-research/scripts/run.mjs']) {
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
