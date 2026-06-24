#!/usr/bin/env node

/**
 * Cross-platform build of all distribution artifacts via the esbuild JS API.
 *
 * Using the JS API (not shell `esbuild ...` invocations) removes every
 * shell-quoting hazard between POSIX `sh` and Windows `cmd.exe` — most notably
 * the `--banner:js='#!/usr/bin/env node'` shebang, whose single quotes are not
 * grouping characters in cmd.exe and so split the build on the space. The
 * banner is just a JS string here, identical on every platform.
 *
 * Targets (dispatch by argv, or build all when no/`all` arg):
 *   worker   -> src/infrastructure/browser/thread-worker.mjs  (browser worker)
 *   openclaw -> dist/openclaw-entry.js (+ dist/prompts, dist/thread-worker.mjs)
 *   cli      -> dist/cli.mjs                 (pi-research CLI binary, shebang)
 *   skill    -> skills/research/scripts/run.mjs  (skill launcher, shebang)
 *
 * Note: `packages: 'external'` already externalizes every bare/`node:` import,
 * so the old `--external:node:*` flag was redundant — output is identical.
 */

'use strict';

const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SHEBANG = '#!/usr/bin/env node';

const COMMON = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  logLevel: 'warning',
};

const p = (...segs) => path.join(ROOT, ...segs);

function copyOpenclawResources() {
  fs.mkdirSync(p('dist', 'prompts'), { recursive: true });
  for (const f of fs.readdirSync(p('src', 'prompts'))) {
    fs.copyFileSync(p('src', 'prompts', f), p('dist', 'prompts', f));
  }
  fs.copyFileSync(
    p('src', 'infrastructure', 'browser', 'thread-worker.mjs'),
    p('dist', 'thread-worker.mjs'),
  );
  console.error('Openclaw resources copied to dist/');
}

const TARGETS = {
  worker: () =>
    esbuild.build({
      ...COMMON,
      entryPoints: [p('src', 'infrastructure', 'browser', 'thread-worker.ts')],
      outfile: p('src', 'infrastructure', 'browser', 'thread-worker.mjs'),
    }),
  openclaw: async () => {
    await esbuild.build({
      ...COMMON,
      entryPoints: [p('src', 'openclaw-entry.ts')],
      outfile: p('dist', 'openclaw-entry.js'),
    });
    copyOpenclawResources();
  },
  cli: () =>
    esbuild.build({
      ...COMMON,
      entryPoints: [p('src', 'cli.ts')],
      outfile: p('dist', 'cli.mjs'),
      banner: { js: SHEBANG },
    }),
  skill: () =>
    esbuild.build({
      ...COMMON,
      entryPoints: [p('skills', 'research', 'scripts', 'run.ts')],
      outfile: p('skills', 'research', 'scripts', 'run.mjs'),
      banner: { js: SHEBANG },
    }),
};

// The openclaw resource-copy step depends on the worker output existing, so the
// full build runs worker before openclaw; cli and skill are independent.
const ALL_ORDER = ['worker', 'openclaw', 'cli', 'skill'];

async function main() {
  const arg = process.argv[2];
  const targets = !arg || arg === 'all' ? ALL_ORDER : [arg];

  for (const name of targets) {
    const build = TARGETS[name];
    if (!build) {
      console.error(`[build] Unknown target: ${name}`);
      console.error(`[build] Valid targets: ${Object.keys(TARGETS).join(', ')}, all`);
      process.exit(1);
    }
    await build();
  }
}

main().catch((err) => {
  console.error('[build] Build failed:', err && err.message ? err.message : err);
  process.exit(1);
});
