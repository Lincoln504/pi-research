#!/usr/bin/env node
'use strict';

/**
 * Make npm 12 the active npm for the rest of a CI job WITHOUT replacing the
 * bundled npm in place.
 *
 * `npm install -g npm@12` cannot be used on the Node 22.22.2 legs. That Node
 * bundles npm 10.9.7, and installing a new npm over itself reifies the global
 * tree while npm's own node_modules entries are being deleted — the still
 * running process then dies with `Cannot find module 'promise-retry'` loaded
 * from `@npmcli/arborist/lib/arborist/rebuild.js`. It is not an engines check:
 * `--force`, `--ignore-scripts` and `--no-audit --no-fund` all reproduce it
 * (verified locally on v22.22.2 and in CI runs 35414345489 and 35414867837, on
 * the ubuntu/macOS unit-test and validate legs; the Node 24 leg and the Windows
 * leg happen to survive because they bundle npm 11.x / use different shims).
 *
 * Installing into a dedicated prefix never touches the running npm, and the
 * prefix's bin dir is put first on PATH for the remaining steps via the
 * `$GITHUB_PATH` file the runner provides.
 *
 * Usage (as a workflow step):  node scripts/use-npm12.cjs
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Candidate bin dirs for a global prefix, platform-correct one first. npm puts
 * global shims in `<prefix>/bin` on POSIX and directly in `<prefix>` on
 * Windows; both are returned so the caller can add whichever exists (an extra
 * PATH entry pointing at a missing dir is harmless).
 */
function binDirsFor(prefix, platform = process.platform) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const primary = platform === 'win32' ? prefix : p.join(prefix, 'bin');
  const secondary = platform === 'win32' ? p.join(prefix, 'bin') : prefix;
  return [primary, secondary];
}

function main() {
  const base = process.env.RUNNER_TEMP || os.tmpdir();
  const prefix = path.join(base, 'npm12');
  fs.rmSync(prefix, { recursive: true, force: true });

  // Quote the prefix: RUNNER_TEMP can contain spaces on some images.
  execFileSync(`npm install -g npm@12 --prefix "${prefix}"`, { stdio: 'inherit', shell: true });

  const cli = path.join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!fs.existsSync(cli)) {
    console.error(`[use-npm12] npm 12 CLI not found at ${cli} after install; prefix layout unexpected`);
    process.exit(1);
  }
  const version = execFileSync(process.execPath, [cli, '-v'], { encoding: 'utf8' }).trim();

  const dirs = binDirsFor(prefix);
  const ghPath = process.env.GITHUB_PATH;
  if (ghPath) {
    // '\n', not os.EOL: the runner parses GITHUB_PATH by line, and a CRLF entry
    // would carry a trailing \r into PATH on Windows.
    fs.appendFileSync(ghPath, dirs.map((d) => d + '\n').join(''));
    console.log(`[use-npm12] npm ${version} installed at ${prefix}; added to GITHUB_PATH: ${dirs.join(', ')}`);
  } else {
    console.log(`[use-npm12] npm ${version} installed at ${prefix} (GITHUB_PATH unset; not exported)`);
  }
}

if (require.main === module) main();

module.exports = { binDirsFor };
