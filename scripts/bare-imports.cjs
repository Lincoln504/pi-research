'use strict';

/**
 * Bare-specifier scan for the shipped standalone-process bundles.
 *
 * The browser worker (a poolifier cluster child) and the PDF worker (a worker_thread) are
 * plain Node processes: they get no help from pi's extension loader, which aliases
 * `typebox` and `@earendil-works/*` for in-process extension code only. A bare import in
 * one of these bundles therefore has to resolve from the INSTALLED package's own
 * node_modules, i.e. it must be a real dependency. A peer dependency is not enough:
 * `pi install` runs npm with --legacy-peer-deps, so peers are never installed there.
 * v1.7.9-v1.7.18 shipped a worker importing the peer `typebox`; every search worker died
 * at import (ERR_MODULE_NOT_FOUND, exit code 1) for every `pi install` user.
 */

const fs = require('fs');
const { builtinModules } = require('module');

const WORKER_BUNDLES = [
  'src/infrastructure/browser/thread-worker.mjs',
  'dist/thread-worker.mjs',
  'src/web-research/pdf-extract-worker.mjs',
  'dist/pdf-extract-worker.mjs',
];

function packageName(spec) {
  return spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
}

/** Bare package names an ESM bundle imports (static, dynamic and re-export forms). */
function bareImports(source) {
  const out = new Set();
  const re = /(?:^|[\s;}(])(?:import|export)\s*(?:[^'"()]*?\sfrom\s*)?["']([^"'./][^"']*)["']|\bimport\s*\(\s*["']([^"'./][^"']*)["']\s*\)/gm;
  for (const m of source.matchAll(re)) {
    const spec = m[1] ?? m[2];
    if (spec.startsWith('node:') || builtinModules.includes(spec.split('/')[0])) continue;
    out.add(packageName(spec));
  }
  return out;
}

/** Names a standalone process may import: what npm installs for a consumer, peers excluded. */
function installedRuntimeNames(pkg) {
  return new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {})]);
}

/** Returns [{ file, name }] for every bare import that would not resolve under --legacy-peer-deps. */
function unresolvableImports(root, pkg, files = WORKER_BUNDLES) {
  const allowed = installedRuntimeNames(pkg);
  const bad = [];
  for (const rel of files) {
    const full = require('path').join(root, rel);
    if (!fs.existsSync(full)) continue;
    for (const name of bareImports(fs.readFileSync(full, 'utf8'))) {
      if (!allowed.has(name)) bad.push({ file: rel, name });
    }
  }
  return bad;
}

module.exports = { WORKER_BUNDLES, bareImports, installedRuntimeNames, unresolvableImports };
