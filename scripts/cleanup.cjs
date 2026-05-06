#!/usr/bin/env node

const { rmSync, existsSync } = require('fs');
const path = require('path');

// __dirname is a built-in global in CommonJS (.cjs) modules
const projectRoot = path.join(__dirname, '..');

// Remove legacy project-local browser cache if present
const legacyCacheDir = path.join(projectRoot, '.browser');
if (existsSync(legacyCacheDir)) {
  try {
    rmSync(legacyCacheDir, { recursive: true, force: true });
  } catch (error) {
    console.warn(`pi-research: could not remove ${legacyCacheDir}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

process.exit(0);
