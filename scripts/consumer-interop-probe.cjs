#!/usr/bin/env node
/**
 * Consumer-tree interop probe (CI-only; not shipped in the package tarball).
 *
 * Proves the knowledge-store's Arrow/LanceDB boundary works when pi-research
 * is resolved from a fresh npm consumer install. The pin rationale
 * (docs/ARCHITECTURE.md, "Pinned data stack"): apache-arrow must be the exact
 * 21.1.0 because lancedb 0.37.x's Rust reader cannot parse 21.2.0 IPC.
 * Before 1.7.18 LanceDB was resolved from the registry, so a consumer tree held TWO
 * Arrow copies (its declared peer ceiling `<=18.1.0` hoisted for LanceDB, our 21.1.0
 * nested under the package). LanceDB is now bundled inside the package
 * (scripts/prepack-lancedb.cjs) and shares the single 21.1.0 copy, the same layout the
 * dev tree and every test run on; this probe asserts that layout actually works.
 *
 * This script replicates src/knowledge/store-schema.ts's createStoreTable call
 * shape (same fields, same FTS/BTree index set, same reopen-from-disk) using
 * exactly the resolution a consumer process gets, resolved from the installed
 * package. It is the regression net for that boundary — the dev-tree integration
 * suite cannot catch a divergence that only exists in the consumer layout.
 *
 * Usage: node scripts/consumer-interop-probe.cjs <tree-root> <package-dir>
 *   <tree-root>   node_modules root of the fresh consumer install
 *   <package-dir> the installed @lincoln504/pi-research package directory
 * Exits 0 on success, 1 on any failure.
 */
const fs = require('node:fs');
const path = require('node:path');

const [treeRoot, packageDir] = process.argv.slice(2);

function fail(message) {
  console.error(`consumer-interop-probe: ${message}`);
  process.exit(1);
}

if (!treeRoot || !packageDir) {
  fail('usage: node scripts/consumer-interop-probe.cjs <tree-root> <package-dir>');
}
// Resolve exactly as the consumer's process does, from the installed package: LanceDB is
// bundled inside it (scripts/prepack-lancedb.cjs), and apache-arrow is the single copy the
// package depends on.
const { createRequire } = require('node:module');
const fromPackage = createRequire(path.join(packageDir, 'package.json'));
let lancedb;
let arrow21;
try {
  lancedb = fromPackage('@lancedb/lancedb');
  arrow21 = fromPackage('apache-arrow');
} catch (e) {
  fail(`cannot resolve @lancedb/lancedb / apache-arrow from ${packageDir}: ${e.message}`);
}
if (!fs.existsSync(path.join(packageDir, 'node_modules', '@lancedb', 'lancedb', 'package.json'))) {
  fail(`@lancedb/lancedb is not bundled inside ${packageDir}`);
}
const { Schema, Field, Float32, FixedSizeList, Utf8, Int64, Bool } = arrow21;
const { Index } = lancedb;

// `pkg/package.json` is not an exports subpath of every package, so walk up from the
// resolved entry file to the manifest that carries the name.
function versionOf(name) {
  try {
    let dir = path.dirname(fromPackage.resolve(name));
    for (let i = 0; i < 6; i++, dir = path.dirname(dir)) {
      const f = path.join(dir, 'package.json');
      if (fs.existsSync(f)) {
        const j = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (j.name === name) return j.version;
      }
    }
  } catch {}
  return '?';
}
const arrowVersion = versionOf('apache-arrow');
const lancedbVersion = versionOf('@lancedb/lancedb');
console.error(
  `consumer-interop-probe: arrow ${arrowVersion} (ours) \u00d7 lancedb ${lancedbVersion} (bundled)`,
);

const { tmpdir } = require('node:os');

async function main() {
  const tmp = path.join(tmpdir(), `pi-research-interop-${process.pid}`);
  fs.mkdirSync(tmp, { recursive: true });
  const dim = 64;
  const schema = new Schema([
    new Field('vector', new FixedSizeList(dim, new Field('item', new Float32())), false),
    new Field('url', new Utf8(), false),
    new Field('text', new Utf8(), false),
    new Field('content', new Utf8(), true),
    new Field('metadata', new Utf8(), false),
    new Field('workspace', new Utf8(), false),
    new Field('is_global', new Bool(), false),
    new Field('ingestion_type', new Utf8(), false),
    new Field('timestamp', new Int64(), false),
  ], new Map([['embedding_model', 'interop-probe'], ['schema_version', '4']]));
  const db = await lancedb.connect(tmp);
  const table = await db.createTable({ name: 'knowledge', data: [], schema });
  await table.createIndex('text', { config: Index.fts() });
  await table.createIndex('content', { config: Index.fts() });
  await table.createIndex('url', { config: Index.btree() });
  await table.createIndex('timestamp', { config: Index.btree() });
  await table.createIndex('workspace', { config: Index.btree() });
  await table.createIndex('is_global', { config: Index.btree() });
  await table.createIndex('ingestion_type', { config: Index.btree() });
  if (await table.countRows() !== 0) return fail('unexpected row count after create');
  await db.close();
  // Reopen from disk — exercises the IPC read/write boundary.
  const db2 = await lancedb.connect(tmp);
  const reopened = await db2.openTable('knowledge');
  if (await reopened.countRows() !== 0) return fail('unexpected row count after reopen');
  await db2.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.error('consumer-interop-probe: OK — schema create, all indexes, reopen from disk succeeded');
}

main().then(() => process.exit(0)).catch((e) => {
  fail(`store boundary failed in consumer tree: ${e instanceof Error ? e.message : String(e)}`);
});