#!/usr/bin/env node

/**
 * prepack: ship @lancedb/lancedb inside the tarball with ALL of its optional
 * dependencies removed (two of which have no use here; see below for the platform bindings).
 *
 * Why: @lancedb/lancedb declares `@huggingface/transformers` 3.0.2 (an EXACT pin, which
 * needs sharp ^0.33.5 — three high advisories) and `openai` as optionalDependencies.
 * npm installs optional dependencies, and a package's `overrides` field is honoured only
 * when that package is the root of the install, so every consumer got the vulnerable
 * sharp unless they added their own override. A published npm-shrinkwrap.json does not
 * help (measured: npm re-resolves the pin). Bundling is the one packaging-level fix:
 * npm installs a bundled dependency's files as shipped, and resolves only the edges its
 * package.json declares. This script removes those two edges (and the platform-binding
 * ones, which are re-declared at the root) from the copy that gets bundled, and checks
 * the rest of the bundle is self-consistent.
 *
 * This repo never uses LanceDB's embedding registry (embeddings run through the root
 * @huggingface/transformers), so nothing in the wrapper needs either package.
 *
 * Remove this script, `bundleDependencies` and the root `optionalDependencies` once
 * LanceDB stops pinning transformers 3.0.2 (docs/AUDIT-GATE.md, "clearsWhen").
 *
 * Idempotent. Exits non-zero, failing `npm pack`, if the bundle would be incomplete.
 *
 * The wrapper manifest is rewritten as a fixed-point transform: applying it twice yields
 * identical bytes, so the write is unconditional and there is no check-then-write on the
 * wrapper file (CodeQL js/file-system-race). The absence checks that used to gate the
 * writes are folded into the reads' error handling.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PKG = 'node_modules/@lancedb/lancedb/package.json';
const PLATFORM = /^@lancedb\/lancedb-/;

function fail(msg) {
  console.error(`prepack-lancedb: ${msg}`);
  process.exit(1);
}

const root = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const wrapperPath = path.join(ROOT, PKG);
let wrapper;
try {
  wrapper = JSON.parse(fs.readFileSync(wrapperPath, 'utf8'));
} catch {
  fail(`${PKG} is not installed — run npm ci first.`);
}

const bundled = new Set(root.bundleDependencies ?? []);
if (!bundled.has('@lancedb/lancedb')) fail('package.json bundleDependencies must list @lancedb/lancedb.');
if (root.dependencies?.['@lancedb/lancedb'] !== wrapper.version) {
  fail(`root dependency @lancedb/lancedb (${root.dependencies?.['@lancedb/lancedb']}) must be pinned to the installed ${wrapper.version}.`);
}

// 1. Strip EVERY optional edge from the copy that gets bundled. Dropping only the two
//    unwanted ones is not enough: npm bundles whatever a bundled package's optional
//    edges resolve to in the local node_modules, so the platform binding installed on the
//    packing machine (a ~200 MB .node file, wrong for every other platform) would ship.
//    The original list is kept under a marker key so the script stays idempotent and the
//    shipped manifest says what was removed.
const MARK = 'x-pi-research-original-optionalDependencies';
const PEER_MARK = 'x-pi-research-original-peerDependencies';
const original = wrapper[MARK] ?? wrapper.optionalDependencies ?? {};
const kept = Object.fromEntries(Object.entries(original).filter(([name]) => PLATFORM.test(name)));

// 1b. Widen the wrapper's apache-arrow peer range to the exact version this package depends
//     on. The wrapper declares `>=15 <=18.1.0`; with it bundled, the consumer tree holds a
//     single apache-arrow (our pinned 21.1.0, the same copy the dev tree and every test run
//     against), so npm would mark that peer edge invalid and `npm ls` would exit non-zero in
//     every consumer project. The original range is kept under a marker key.
const arrowPin = root.dependencies?.['apache-arrow'];
if (!arrowPin) fail('package.json must pin apache-arrow as a dependency.');
const originalPeers = wrapper[PEER_MARK] ?? wrapper.peerDependencies ?? {};

const out = { ...wrapper };
delete out.optionalDependencies;
out[MARK] = original;
const arrowPeer = originalPeers['apache-arrow'];
if (arrowPeer) {
  out[PEER_MARK] = originalPeers;
  out.peerDependencies = { ...originalPeers, 'apache-arrow': `${arrowPeer} || ${arrowPin}` };
}
fs.writeFileSync(wrapperPath, JSON.stringify(out, null, 2) + '\n');
console.log(`prepack-lancedb: bundled wrapper ready (${Object.keys(kept).length} platform bindings, optional edges stripped).`);

// 2. The platform bindings are therefore no longer reachable through the wrapper, so the
//    root must declare each one, at the wrapper's own version. npm resolves them per
//    os/cpu/libc and hoists them next to the bundled wrapper, where its loader finds them.
for (const [name, range] of Object.entries(kept)) {
  if (root.optionalDependencies?.[name] !== range) {
    fail(`package.json optionalDependencies must declare ${name}@${range} (found ${root.optionalDependencies?.[name]}).`);
  }
}
for (const name of Object.keys(root.optionalDependencies ?? {})) {
  if (PLATFORM.test(name) && !(name in kept)) fail(`stale root optionalDependency ${name}: the wrapper no longer declares it.`);
}

// 3. The bundle must carry the wrapper's whole runtime closure.
for (const dep of Object.keys(wrapper.dependencies ?? {})) {
  if (!bundled.has(dep)) fail(`bundleDependencies is missing ${dep}, a runtime dependency of @lancedb/lancedb.`);
  const sub = path.join(ROOT, 'node_modules', dep, 'package.json');
  let subJson;
  try {
    subJson = JSON.parse(fs.readFileSync(sub, 'utf8'));
  } catch {
    fail(`${dep} is not installed.`);
  }
  for (const d2 of Object.keys(subJson.dependencies ?? {})) {
    if (!bundled.has(d2)) fail(`bundleDependencies is missing ${d2}, a runtime dependency of ${dep}.`);
  }
}
// 4. npm computes the bundle from node_modules/.package-lock.json (the hidden lockfile)
//    whenever it considers it current, and it does NOT notice an edited package.json inside
//    node_modules: the first pack after an install would still bundle the stripped
//    wrapper's old optional edges (measured: a 229 MB tarball carrying the native binding).
//    Removing the file forces npm to read the manifests; it rebuilds the file itself.
//    force: true makes the removal a no-op when the file is absent, so no existence check.
const hidden = path.join(ROOT, 'node_modules', '.package-lock.json');
fs.rmSync(hidden, { force: true });

console.log(`prepack-lancedb: @lancedb/lancedb ${wrapper.version} bundle OK (${Object.keys(kept).length} platform bindings declared at the root).`);
