#!/usr/bin/env node
/**
 * Sync SKILL.md's `version` metadata to package.json's version.
 *
 * Run from the `version` npm lifecycle so the tagged commit carries a SKILL.md
 * whose version matches the package — `verify-package.cjs` and the release
 * workflow both check that they agree.
 *
 * This lives in a file rather than inline in package.json because the inline form
 * needed 11 double-quote characters, all of them before the `&&` that chained the
 * `git add`. npm runs scripts through `cmd.exe /d /s /c "<script>"` on Windows, and
 * cmd has no backslash escape — it just toggles an "inside quotes" flag on every
 * `"`. An odd count left that flag ON at the `&&`, so cmd passed `&&` to node as a
 * literal argument instead of treating it as a command separator: SKILL.md was
 * rewritten but never staged, and the tag pointed at a commit where the two
 * versions disagreed. A quote-free npm script cannot hit that.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKILL_PATH = path.join(ROOT, 'agent-skill', 'pi-research', 'SKILL.md');

const { version } = require(path.join(ROOT, 'package.json'));

const original = fs.readFileSync(SKILL_PATH, 'utf8');
const updated = original.replace(/"version": "[^"]*"/, `"version": "${version}"`);

if (updated === original && !original.includes(`"version": "${version}"`)) {
  // Fail loudly rather than tagging a release whose SKILL.md silently kept the old
  // version — the downstream checks would catch it, but only much later.
  console.error(`[sync-skill-version] No "version" field found in ${SKILL_PATH}`);
  process.exit(1);
}

fs.writeFileSync(SKILL_PATH, updated);
console.log(`✔ synced SKILL.md to v${version}`);
