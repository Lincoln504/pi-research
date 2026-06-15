#!/usr/bin/env node

/**
 * Build the openclaw bundle and worker bundle.
 *
 * esbuild is a regular dependency, so it is always available on any install
 * (including git installs and --omit=dev). dist/ is not tracked in git;
 * this script always builds the artifacts from source.
 */

'use strict';

const { execSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');

try {
  execSync('npm run build:worker && npm run build:openclaw', { stdio: 'inherit', cwd: ROOT });
} catch (err) {
  console.error('[prepare] Build failed:', err.message);
  process.exit(1);
}
