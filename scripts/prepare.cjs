#!/usr/bin/env node

/**
 * Build all distribution artifacts.
 *
 * esbuild is a regular dependency, so it is always available on any install
 * (including git installs and --omit=dev). dist/ is not tracked in git;
 * this script always builds the artifacts from source.
 *
 * Artifacts built:
 *   - dist/thread-worker.mjs       (browser worker, via build:worker)
 *   - dist/cli.mjs (+ dist/prompts, dist/webgpu-probe.mjs)  (pi-research CLI binary, via build:cli)
 *   - skills/pi-research/scripts/run.mjs  (skill launcher, via build:skill)
 */

'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// spawnSync with an argv array, not execSync with a quoted string: execSync goes
// through /bin/sh -c, where $(…), backticks and quotes stay live INSIDE double
// quotes — so a Node binary path under a directory named with shell metacharacters
// would execute them during npm ci / a git install. Same fix setup.cjs and
// cleanup.cjs already carry. process.execPath (not a bare 'node') for the same
// reason as ensure-native-deps.cjs: a PATH lookup can resolve a different
// interpreter (nvm-windows, Volta, a portable Node) than the one running npm.
const r = spawnSync(process.execPath, ['scripts/build.cjs', 'all'], { stdio: 'inherit', cwd: ROOT });
if (r.error) {
  console.error('[prepare] Build failed:', r.error.message);
  process.exit(1);
}
if (r.status !== 0) {
  console.error(`[prepare] Build failed with exit code ${r.status}`);
  process.exit(r.status ?? 1);
}
