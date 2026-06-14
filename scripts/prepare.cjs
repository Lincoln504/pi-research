#!/usr/bin/env node

/**
 * Build the openclaw bundle and worker bundle if esbuild is available.
 *
 * When installed with --omit=dev (e.g. `pi install git:...`), esbuild is absent.
 * In that case we copy the pre-built dist/ artifacts into the locations the source
 * tree expects at runtime:
 *   dist/thread-worker.mjs  →  src/infrastructure/browser/thread-worker.mjs
 *   dist/prompts/           →  (already found via fallback path in prompts.ts)
 */

'use strict';

const { execSync } = require('child_process');
const { copyFileSync, existsSync, mkdirSync } = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let esbuildAvailable = false;
try {
  require.resolve('esbuild');
  esbuildAvailable = true;
} catch {
  // Not installed — omit=dev or similar
}

if (!esbuildAvailable) {
  console.log('[prepare] esbuild not available — deploying pre-built dist/ artifacts.');

  // Copy the bundled worker into the location the source-tree expects.
  // worker-pool-manager.ts does: join(__dirname, './thread-worker.mjs')
  // where __dirname = src/infrastructure/browser/, so the worker must live there.
  const src = path.join(ROOT, 'dist', 'thread-worker.mjs');
  const dst = path.join(ROOT, 'src', 'infrastructure', 'browser', 'thread-worker.mjs');

  if (existsSync(src)) {
    try {
      mkdirSync(path.dirname(dst), { recursive: true });
      copyFileSync(src, dst);
      console.log('[prepare] Copied dist/thread-worker.mjs → src/infrastructure/browser/thread-worker.mjs');
    } catch (err) {
      console.error('[prepare] Failed to copy thread-worker.mjs:', err.message);
      process.exit(1);
    }
  } else {
    console.error('[prepare] dist/thread-worker.mjs not found — cannot deploy worker. Run npm run build:worker first.');
    process.exit(1);
  }

  process.exit(0);
}

try {
  execSync('npm run build:worker && npm run build:openclaw', { stdio: 'inherit' });
} catch (err) {
  console.error('[prepare] Build failed:', err.message);
  process.exit(1);
}
