#!/usr/bin/env node

/**
 * Release-changelog gate.
 *
 * The changelog is the release record, and nothing in the release path ever
 * required it to stay complete. It has silently lost entries twice:
 *
 *   - v1.6.12 (2026-09-07) was tagged with its content still under
 *     `## [Unreleased]`; the block was later folded into `## [1.6.13]`, so the
 *     release has no section and its changes are attributed to the next one.
 *   - v1.6.17 (2026-09-09) was tagged the same way, but the next release
 *     rewrote `[Unreleased]` instead of folding it, so its only change was
 *     deleted outright and is documented nowhere.
 *
 * Both shipped because the release commit only bumps package.json/SKILL.md and
 * pushes a tag; CI validates the tag against those two files but never against
 * the changelog. This gate fails closed instead. The version in package.json
 * MUST have:
 *
 *   1. its own `## [x.y.z]` heading, and
 *   2. a ` - YYYY-MM-DD` release date on that heading, and
 *   3. at least one entry beneath it (no empty stub sections), and
 *   4. the NEWEST release heading in the file — nothing but `## [Unreleased]`
 *      may sit above it, so a section that exists but was never moved up is
 *      still caught.
 *
 * Usage:
 *   node scripts/verify-changelog.cjs [--changelog <path>] [--version <x.y.z>]
 *
 * Exits 0 when the record is complete, 1 with an actionable message otherwise.
 * Pure logic is exported for unit tests (see
 * test/unit/scripts/verify-changelog.test.ts).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DEFAULT_CHANGELOG = path.join(ROOT, 'docs', 'CHANGELOG.md');
const DEFAULT_PACKAGE = path.join(ROOT, 'package.json');

/** `## [name]` or `## [name] - YYYY-MM-DD` at the start of a line. */
const HEADING_RE = /^##\s+\[([^\]]+)\](?:\s*-\s*(\d{4}-\d{2}-\d{2}))?\s*$/gm;
const RELEASE_RE = /^\d+\.\d+\.\d+$/;
const UNRELEASED = 'Unreleased';

/**
 * Split a changelog into its `##` sections in document order.
 *
 * @param {string} markdown
 * @returns {Array<{name: string, date: string|null, start: number, end: number, body: string}>}
 */
function parseSections(markdown) {
  const sections = [];
  const matches = [...markdown.matchAll(HEADING_RE)];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const start = m.index;
    const end = i + 1 < matches.length ? matches[i + 1].index : markdown.length;
    sections.push({
      name: m[1].trim(),
      date: m[2] ?? null,
      start,
      end,
      body: markdown.slice(start + m[0].length, end),
    });
  }
  return sections;
}

/** True when a section body has at least one non-blank, non-heading line. */
function hasEntry(body) {
  return body.split('\n').some((line) => {
    const t = line.trim();
    return t !== '' && !t.startsWith('#');
  });
}

/**
 * Check a changelog against a version.
 *
 * @param {{markdown: string, version: string}} input
 * @returns {{ok: boolean, errors: string[]}}
 */
function checkChangelog({ markdown, version }) {
  const errors = [];
  const sections = parseSections(markdown);
  const releases = sections.filter((s) => RELEASE_RE.test(s.name));
  const matches = releases.filter((s) => s.name === version);

  if (matches.length === 0) {
    errors.push(
      `docs/CHANGELOG.md has no "## [${version}]" section for the version in package.json. ` +
        `Add one (dated) before tagging: an untagged release section cannot be reconstructed later.`,
    );
  } else if (matches.length > 1) {
    errors.push(`docs/CHANGELOG.md has ${matches.length} "## [${version}]" sections; keep exactly one.`);
  }

  const target = matches[0];
  if (target) {
    if (!target.date) {
      errors.push(`"## [${version}]" has no release date; every release heading carries " - YYYY-MM-DD".`);
    } else if (Number.isNaN(Date.parse(target.date))) {
      errors.push(`"## [${version}]" has an unparseable date "${target.date}"; use YYYY-MM-DD.`);
    }
    if (!hasEntry(target.body)) {
      errors.push(`"## [${version}]" is an empty section; record at least one change.`);
    }
    const newest = releases[0];
    if (newest && newest.name !== version) {
      errors.push(
        `"## [${version}]" is not the newest release section — "## [${newest.name}]" sits above it. ` +
          `Move the ${version} section to the top of the release list (below "## [${UNRELEASED}]").`,
      );
    }
  }

  return { ok: errors.length === 0, errors };
}

function parseArgs(argv) {
  const out = { changelog: DEFAULT_CHANGELOG, version: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--changelog') out.changelog = argv[++i];
    else if (a === '--version') out.version = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a.startsWith('--changelog=')) out.changelog = a.slice('--changelog='.length);
    else if (a.startsWith('--version=')) out.version = a.slice('--version='.length);
    else {
      console.error(`verify-changelog: unknown argument "${a}"`);
      process.exit(2);
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('usage: node scripts/verify-changelog.cjs [--changelog <path>] [--version <x.y.z>]');
    process.exit(0);
  }

  let version = args.version;
  if (!version) {
    version = JSON.parse(fs.readFileSync(DEFAULT_PACKAGE, 'utf8')).version;
  }
  if (!version) {
    console.error('verify-changelog: could not determine the version to check.');
    process.exit(1);
  }

  let markdown;
  try {
    markdown = fs.readFileSync(args.changelog, 'utf8');
  } catch (err) {
    console.error(`verify-changelog: cannot read ${args.changelog}: ${err.message}`);
    process.exit(1);
  }

  const { ok, errors } = checkChangelog({ markdown, version });
  if (!ok) {
    console.error(`verify-changelog: FAIL — the release record is incomplete for v${version}:`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(`verify-changelog: OK — docs/CHANGELOG.md has a dated, newest "## [${version}]" section.`);
}

if (require.main === module) main();

module.exports = { parseSections, checkChangelog, hasEntry };
