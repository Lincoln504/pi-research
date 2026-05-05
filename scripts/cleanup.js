#!/usr/bin/env node

/**
 * pi-research Uninstall Cleanup Script
 *
 * This script runs when the package is uninstalled and cleans up:
 * 1. Local browser cache (.browser directory)
 * 2. Temporary files created during operation
 */

import { rmSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

console.log('🧹 Cleaning up pi-research...');

// Clean up local browser cache
const browserCacheDir = join(projectRoot, '.browser');
if (existsSync(browserCacheDir)) {
  try {
    rmSync(browserCacheDir, { recursive: true, force: true });
    console.log('✅ Removed browser cache');
  } catch (error) {
    console.warn(`⚠️  Could not remove browser cache: ${error instanceof Error ? error.message : String(error)}`);
    // Don't fail on cleanup errors
  }
}

console.log('✅ Cleanup complete');
process.exit(0);
