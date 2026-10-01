#!/usr/bin/env node
/**
 * CI self-heal for missing native optional dependencies.
 *
 * npm has a long-standing bug (npm/cli#4828) where `npm ci` — especially with
 * `--legacy-peer-deps` — intermittently fails to install a package's
 * platform-specific OPTIONAL dependency (the prebuilt native binding). When it
 * strikes, `@lancedb/lancedb` throws "Cannot find native binding" at load and
 * anything that touches the knowledge store (the store unit tests, a real run)
 * fails. Because our CI caches node_modules, the broken tree is then saved and
 * poisons every subsequent cache-hit run until the lockfile changes.
 *
 * The application code degrades gracefully when the binding is absent (the CLI
 * still runs; the store just disables) — but the store's own tests legitimately
 * need a working binding. This script guarantees one is present: it verifies the
 * binding loads and, if not, installs the exact platform package by name (a
 * direct leaf install is NOT subject to the optional-dependency resolution bug),
 * then re-verifies. It exits non-zero only if a binding still cannot be loaded,
 * so a genuine problem fails the job loudly instead of silently.
 *
 * A second, worse instance of the same bug is repaired here: `npm ci` can drop
 * the ENTIRE optional `@huggingface/transformers` subtree (14 packages in
 * 2026-10-01's tree — transformers, its onnxruntime/global-agent/sharp chain and
 * the tokenizers/jinja packages), silently and with no `npm warn optional` line.
 * Runtime tolerates it (the knowledge store disables cleanly, which is the whole
 * point of the package being optional), but `npm run type-check` does not: `src/`
 * imports its type declarations unconditionally. The release workflow's
 * test-install job runs type-check, so a dropped subtree failed the v1.7.4
 * release run with six `TS2307: Cannot find module '@huggingface/transformers'`
 * errors while the same lockfile installed all 606 packages on a re-run. Hence
 * the repair below: a NAMED install of the pinned version, which is not subject
 * to the optional-dependency resolution bug.
 *
 * Idempotent and fast: on a healthy tree the first require() succeeds and it
 * exits 0 immediately (the common case on macOS/Windows and on a good install).
 */

'use strict';

const { execSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function log(msg) {
  process.stdout.write(`[ensure-native-deps] ${msg}\n`);
}

/**
 * True if `@lancedb/lancedb` loads with its native binding.
 *
 * The check runs in a FRESH child process on purpose: a failed require() in this
 * process poisons the module resolver's internal state, so an in-process re-check
 * after `npm install` reports a false negative even once the binding is present.
 * A clean child gets an unpolluted registry every time.
 */
function lancedbLoads() {
  const r = spawnSync(process.execPath, ['-e', "require('@lancedb/lancedb')"], {
    stdio: 'ignore',
  });
  return r.status === 0;
}

/** Detect glibc vs musl on Linux (GitHub's ubuntu runners are glibc → gnu). */
function linuxLibc() {
  try {
    const report = process.report && process.report.getReport();
    const header = report && report.header;
    if (header) {
      // glibcVersionRuntime is present on glibc, absent on musl. When the report
      // is available it is authoritative: a present value means gnu, and its
      // ABSENCE means musl (not merely "unknown → assume gnu", which mis-selected
      // the gnu binding on non-Alpine musl hosts).
      return header.glibcVersionRuntime ? 'gnu' : 'musl';
    }
  } catch {
    /* report unavailable — fall through to the filesystem heuristic */
  }
  // No usable report: Alpine ships /etc/alpine-release; otherwise assume gnu.
  return fs.existsSync('/etc/alpine-release') ? 'musl' : 'gnu';
}

/**
 * The `@lancedb/lancedb-<platform>` optional package for the current host, or
 * null if lancedb publishes no binding for it (e.g. Intel macOS darwin-x64).
 */
function lancedbPlatformPackage() {
  const arch = process.arch; // 'x64' | 'arm64' | ...
  switch (process.platform) {
    case 'linux':
      return `@lancedb/lancedb-linux-${arch}-${linuxLibc()}`;
    case 'darwin':
      return arch === 'arm64' ? '@lancedb/lancedb-darwin-arm64' : null;
    case 'win32':
      return `@lancedb/lancedb-win32-${arch}-msvc`;
    default:
      return null;
  }
}

/**
 * Version of the installed @lancedb/lancedb (the binding must match exactly), or
 * null if the package itself is not installed. A missing platform binding is
 * repairable by a leaf install; a missing *package* is a broader install failure
 * that this script cannot fix, so callers treat null distinctly.
 */
function lancedbVersion() {
  const pkgJson = path.join(
    process.cwd(),
    'node_modules',
    '@lancedb',
    'lancedb',
    'package.json',
  );
  if (!fs.existsSync(pkgJson)) return null;
  return JSON.parse(fs.readFileSync(pkgJson, 'utf8')).version;
}

/**
 * The optional embedding runtime this repository requires, as {name, version},
 * read from package.json so the pin lives in exactly one place. Returns null if
 * package.json no longer declares it (in which case the type-check that needs it
 * is gone too, and there is nothing to repair).
 *
 * `webgpu`, the other optionalDependencies entry, is deliberately NOT covered:
 * its absence is a supported state on every platform (it is a browser shim) and
 * nothing in the build or type-check path resolves it.
 */
function optionalEmbeddingPin(manifestPath = path.join(process.cwd(), 'package.json')) {
  let deps;
  try {
    deps = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).optionalDependencies || {};
  } catch {
    return null;
  }
  const NAME = '@huggingface/transformers';
  return Object.prototype.hasOwnProperty.call(deps, NAME) ? { name: NAME, version: deps[NAME] } : null;
}

/**
 * True if `name` resolves from this tree. Fresh child process for the same
 * resolver-state reason as lancedbLoads().
 */
function resolvable(name) {
  const r = spawnSync(process.execPath, ['-e', `require.resolve(${JSON.stringify(name)})`], {
    stdio: 'ignore',
  });
  return r.status === 0;
}

/**
 * Repair a dropped optional embedding subtree. Never throws for a reason that is
 * the app's problem: a genuinely absent optional package is a supported runtime
 * state, but it is NOT a supported type-check state, so a repair that does not
 * take fails the job loudly.
 */
function ensureOptionalEmbedding() {
  const pin = optionalEmbeddingPin();
  if (!pin) return;
  if (resolvable(pin.name)) {
    log(`${pin.name} present — nothing to do.`);
    return;
  }

  const spec = `${pin.name}@${pin.version}`;
  log(
    `${pin.name} is missing after npm ci (npm/cli#4828 drops the optional ` +
      `subtree silently). Type-check cannot run without its declarations, so ` +
      `installing ${spec} directly (a named leaf install is not subject to the ` +
      'optional-dep resolution bug)…',
  );
  process.stdout.write(
    `::warning title=Optional embedding runtime repaired::${pin.name} was missing after npm ci; installed ${spec} directly (npm/cli#4828)\n`,
  );

  // --no-save + --no-package-lock keep this repair out of package.json and the
  // tracked lockfile: the tree is repaired, the repository is not modified.
  execSync(
    `npm install --no-save --no-package-lock --no-audit --no-fund --legacy-peer-deps ${spec}`,
    { stdio: 'inherit' },
  );

  if (!resolvable(pin.name)) {
    process.stderr.write(
      `[ensure-native-deps] ERROR: ${spec} was installed but ${pin.name} still ` +
        'does not resolve. Type-check and the knowledge store cannot run on ' +
        'this tree \u2014 run a clean `npm ci` and re-run.\n',
    );
    process.exit(1);
  }
  log(`repair succeeded — ${pin.name} now resolves.`);
}

function main() {
  ensureOptionalEmbedding();

  if (lancedbLoads()) {
    log('lancedb native binding present — nothing to do.');
    return;
  }

  const pkg = lancedbPlatformPackage();
  if (!pkg) {
    log(
      `no lancedb native binding is published for ${process.platform}/${process.arch}; ` +
        'the knowledge store will be unavailable here. This is expected on such ' +
        'platforms and the app degrades gracefully — not treating it as a failure.',
    );
    return;
  }

  const version = lancedbVersion();
  if (!version) {
    process.stderr.write(
      '[ensure-native-deps] ERROR: @lancedb/lancedb is not installed at all ' +
        '(node_modules/@lancedb/lancedb is missing). That is a broader install ' +
        'failure than a dropped native binding and cannot be repaired by a leaf ' +
        'install — run a clean `npm ci`.\n',
    );
    process.exit(1);
  }
  const spec = `${pkg}@${version}`;
  log(
    `native binding missing (npm/cli#4828). Installing ${spec} directly (a named ` +
      'leaf install is not subject to the optional-dep resolution bug)…',
  );
  // GitHub Actions annotation so the repair is visible in the run summary.
  process.stdout.write(
    `::warning title=Native binding repaired::${spec} was missing after npm ci; installed directly (npm/cli#4828)\n`,
  );

  // --legacy-peer-deps mirrors how the project installs everywhere (a peer
  // conflict in the tree makes strict resolution ERESOLVE); --no-save keeps
  // package.json / lockfile untouched.
  execSync(
    `npm install --no-save --no-package-lock --no-audit --no-fund --legacy-peer-deps ${spec}`,
    { stdio: 'inherit' },
  );

  if (!lancedbLoads()) {
    process.stderr.write(
      `[ensure-native-deps] ERROR: ${spec} installed but @lancedb/lancedb still ` +
        'fails to load its native binding.\n',
    );
    process.exit(1);
  }
  log('repair succeeded — lancedb native binding now loads.');
}

// Same shape as scripts/audit-gate.cjs: pure logic exported for the unit test,
// side effects only when run as a CLI.
module.exports = { optionalEmbeddingPin, resolvable, lancedbPlatformPackage, linuxLibc };

if (require.main === module) {
  main();
}
