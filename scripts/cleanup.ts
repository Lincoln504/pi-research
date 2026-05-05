#!/usr/bin/env node

import { rmSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

// Remove legacy project-local browser cache if present
const legacyCacheDir = join(projectRoot, '.browser');
if (existsSync(legacyCacheDir)) {
  try {
    rmSync(legacyCacheDir, { recursive: true, force: true });
  } catch (error) {
    console.warn(`pi-research: could not remove ${legacyCacheDir}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

process.exit(0);
