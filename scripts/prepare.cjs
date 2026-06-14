#!/usr/bin/env node

/**
 * Build the openclaw bundle and worker bundle if esbuild is available.
 * Skips gracefully when installed with --omit=dev (e.g. via `pi install git:...`),
 * relying on the pre-built dist/ files committed to the repository instead.
 */

'use strict';

const { execSync } = require('child_process');

let esbuildAvailable = false;
try {
  require.resolve('esbuild');
  esbuildAvailable = true;
} catch {
  // Not installed — omit=dev or similar
}

if (!esbuildAvailable) {
  console.log('[prepare] esbuild not available — using pre-built dist/ from repository.');
  process.exit(0);
}

try {
  execSync('npm run build:worker && npm run build:openclaw', { stdio: 'inherit' });
} catch (err) {
  console.error('[prepare] Build failed:', err.message);
  process.exit(1);
}
