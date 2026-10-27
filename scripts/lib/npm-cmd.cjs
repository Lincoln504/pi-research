#!/usr/bin/env node
'use strict';

/**
 * Resolve npm for a shell-less (argv array) spawn, on every platform.
 *
 * Why this exists: a bare `npm` in an argv-array spawn is unresolvable on
 * Windows. The npm on PATH there is a `.cmd` shim, and Node's shell-less spawn
 * resolves only exact file names — `npm` is `ENOENT`. `npm.cmd` is not a fix
 * either: since the CVE-2024-27980 hardening (Node 18.20.2 / 20.12.2 / 21.7.3,
 * i.e. every Node 20/22/24), spawning a `.cmd` file directly is rejected
 * outright with `EINVAL`. `shell: true` would work, but it reintroduces
 * exactly the argument parsing the argv-array hardening removed — the
 * arguments include paths read from disk (a `RUNNER_TEMP` prefix, a spec read
 * from an installed `package.json`) that must never be parsed by a shell.
 *
 * So: run the npm CLI that ships INSIDE the Node distribution, directly with
 * the Node binary. The absolute path needs no PATH lookup, no shim resolution
 * and no shell, and the arguments stay a clean argv array.
 *
 * Known layouts of the bundled npm CLI (checked in order):
 *   <node-dir>/node_modules/npm/bin/npm-cli.js
 *       nodejs.org zip/MSI installs and the actions/node-versions builds CI
 *       downloads (the CI "Use npm 12" step runs under exactly this layout)
 *   <node-dir>/../lib/node_modules/npm/bin/npm-cli.js
 *       nvm and Homebrew installs
 *
 * Usage:
 *   const { command, args } = npmInvocation();
 *   execFileSync(command, [...args, 'install', '-g', 'npm@12', '--prefix', prefix],
 *     { stdio: 'inherit' });
 *
 * `execPath` is injectable so tests can pin a layout without a Windows host.
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * Candidate locations of the bundled npm CLI for a node binary at `execPath`,
 * platform-correct one first. Pure path math (no fs), so tests can pin the
 * layout per platform.
 */
function npmCliCandidates(execPath, platform = process.platform) {
  const p = platform === 'win32' ? path.win32 : path;
  const nodeDir = p.dirname(execPath);
  return [
    p.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    p.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
}

/**
 * @param {string} [execPath] the Node binary (default: process.execPath).
 * @returns {{ command: string, args: string[] }} the argv prefix that runs
 * npm without a shell. Primary: the bundled npm CLI run by the Node binary.
 * Fallback (no bundled CLI found — a non-standard Node build): the bare `npm`
 * name, which is correct on POSIX.
 */
function npmInvocation(execPath = process.execPath) {
  const cli = npmCliCandidates(execPath).find((f) => fs.existsSync(f));
  if (cli) return { command: execPath, args: [cli] };
  return { command: 'npm', args: [] };
}

module.exports = { npmCliCandidates, npmInvocation };
