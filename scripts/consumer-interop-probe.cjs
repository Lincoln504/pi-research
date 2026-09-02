#!/usr/bin/env node
/**
 * Consumer-tree interop probe (CI-only; not shipped in the package tarball).
 *
 * Proves the knowledge-store's Arrow/LanceDB boundary works when pi-research
 * is resolved from a fresh npm consumer install. The pin rationale
 * (docs/ARCHITECTURE.md, "Pinned data stack"): apache-arrow must be the exact
 * 21.1.0 because lancedb 0.37.x's Rust reader cannot parse 21.2.0 IPC, and
 * every lancedb release through 0.37 declares a conservative peer ceiling of
 * `>=15.0.0 <=18.1.0`. npm therefore resolves a hoisted 18.1.0 copy for
 * lancedb and nests the pinned 21.1.0 under the package — two Arrow copies in
 * the consumer tree, unlike the single-copy dev tree the override produces.
 *
 * This script replicates src/knowledge/store-schema.ts's createStoreTable call
 * shape (same fields, same FTS/BTree index set, same reopen-from-disk) using
 * exactly the resolution a consumer process gets: the Arrow copy nested under
 * the installed package (21.1.0) and the lancedb npm hoisted for its peer
 * range. It is the regression net for that boundary — the dev-tree integration
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
if (!fs.existsSync(path.join(treeRoot, 'node_modules', '@lancedb', 'lancedb'))) {
  fail(`lancedb not found under ${treeRoot}/node_modules`);
}
if (!fs.existsSync(path.join(packageDir, 'node_modules', 'apache-arrow'))) {
  fail(`apache-arrow not found nested under ${packageDir}/node_modules`);
}

// Bare-specifier resolution from the package (like Node/jiti resolves in-host):
// the NESTED arrow copy under the package wins for pi-research code. Resolve by
// absolute path so the probe never depends on the script's own CWD.
const arrow21 = require(path.join(packageDir, 'node_modules', 'apache-arrow'));
const lancedb = require(path.join(treeRoot, 'node_modules', '@lancedb', 'lancedb'));
const { Schema, Field, Float32, FixedSizeList, Utf8, Int64, Bool } = arrow21;
const { Index } = lancedb;

let arrowVersion = '?';
try { arrowVersion = require(path.join(packageDir, 'node_modules', 'apache-arrow', 'package.json')).version; } catch {}
let lancedbVersion = '?';
try { lancedbVersion = require(path.join(treeRoot, 'node_modules', '@lancedb', 'lancedb', 'package.json')).version; } catch {}
console.error(
  `consumer-interop-probe: arrow ${arrowVersion} (nested/ours) \u00d7 lancedb ${lancedbVersion} (hoisted)`,
);

async function main() {
  const tmp = path.join('/tmp', `pi-research-interop-${process.pid}`);
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