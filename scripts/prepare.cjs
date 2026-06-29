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

const { execSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');

try {
  execSync('node scripts/build.cjs all', { stdio: 'inherit', cwd: ROOT });
} catch (err) {
  console.error('[prepare] Build failed:', err.message);
  process.exit(1);
}
