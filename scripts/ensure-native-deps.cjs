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

function main() {
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
  execSync(`npm install --no-save --no-audit --no-fund --legacy-peer-deps ${spec}`, {
    stdio: 'inherit',
  });

  if (!lancedbLoads()) {
    process.stderr.write(
      `[ensure-native-deps] ERROR: ${spec} installed but @lancedb/lancedb still ` +
        'fails to load its native binding.\n',
    );
    process.exit(1);
  }
  log('repair succeeded — lancedb native binding now loads.');
}

main();
