#!/usr/bin/env node

/**
 * Re-add the two phantom-optional stubs that every plain lockfile regeneration drops.
 *
 * `@kreuzberg/html-to-markdown-node` lists linux-{arm64,x64}-musl platform packages in
 * its optionalDependencies that were never published (the registry 404s). `npm ci`
 * still demands a lock entry for each referenced optional, and `npm install` /
 * `npm update` / `--package-lock-only` silently delete them, so the first CI run after a
 * dependency refresh fails with `Missing: @kreuzberg/...-musl@ from lock file`.
 * test/unit/package.test.ts ("keeps the VERSIONED optional stubs") enforces the end
 * state; this script produces it. Run it after ANY lockfile regeneration:
 *
 *   npm run lock:restore-stubs && npm ci --dry-run
 *
 * Idempotent. Key order is preserved except that the stubs are inserted at their
 * alphabetical position, matching what npm itself would write. Removes nothing.
 *
 * Version source: the parent's own declared optionalDependencies, so a kreuzberg bump
 * does not need this script edited. Clears together with the test when kreuzberg
 * publishes the musl variants or drops the references.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const LOCK = path.join(__dirname, '..', 'package-lock.json');
const PARENT = 'node_modules/@kreuzberg/html-to-markdown-node';
const VARIANTS = ['linux-arm64-musl', 'linux-x64-musl'];

function main() {
  const lock = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
  const parent = lock.packages && lock.packages[PARENT];
  if (!parent) {
    console.log('restore-lock-stubs: kreuzberg is not in the lockfile; nothing to do.');
    return;
  }
  const optionals = parent.optionalDependencies || {};
  let added = 0;
  const additions = {};
  for (const variant of VARIANTS) {
    const name = `@kreuzberg/html-to-markdown-node-${variant}`;
    const key = `node_modules/${name}`;
    if (!(name in optionals)) continue; // parent no longer references it: stub not needed
    if (lock.packages[key]) continue;
    const version = optionals[name];
    additions[key] = {
      version,
      resolved: `https://registry.npmjs.org/${name}/-/html-to-markdown-node-${variant}-${version}.tgz`,
      optional: true,
    };
    added++;
  }
  if (added === 0) {
    console.log('restore-lock-stubs: stubs already present (or no longer referenced).');
    return;
  }
  const merged = { ...lock.packages, ...additions };
  lock.packages = Object.fromEntries(
    Object.keys(merged)
      .sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a < b ? -1 : a > b ? 1 : 0))
      .map((k) => [k, merged[k]]),
  );
  fs.writeFileSync(LOCK, JSON.stringify(lock, null, 2) + '\n');
  console.log(`restore-lock-stubs: re-added ${added} stub(s). Verify with: npm ci --dry-run`);
}

main();
