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
 *   cli      -> dist/cli.mjs (+ dist/prompts, dist/thread-worker.mjs, dist/webgpu-probe.mjs)
 *   skill    -> skills/pi-research/scripts/run.mjs  (skill launcher, shebang)
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

// The out-of-process WebGPU viability probe is plain .mjs (not bundled). It must
// sit next to the bundled entry points so the embedder can resolve it relative to
// import.meta.url, and so it resolves @huggingface/transformers from the installed
// package's node_modules. The bundled dist/cli.mjs depends on it.
function copyWebGpuProbe() {
  fs.mkdirSync(p('dist'), { recursive: true });
  fs.copyFileSync(
    p('src', 'knowledge', 'webgpu-probe.mjs'),
    p('dist', 'webgpu-probe.mjs'),
  );
}

// Build the browser worker bundle. Factored out so the cli target can guarantee
// it exists when built in isolation (`build:cli`), not only via `build all`.
function buildWorker() {
  return esbuild.build({
    ...COMMON,
    entryPoints: [p('src', 'infrastructure', 'browser', 'thread-worker.ts')],
    outfile: p('src', 'infrastructure', 'browser', 'thread-worker.mjs'),
  });
}

async function ensureWorkerBuilt() {
  const src = p('src', 'infrastructure', 'browser', 'thread-worker.ts');
  const out = p('src', 'infrastructure', 'browser', 'thread-worker.mjs');
  // Rebuild if the bundle is missing OR older than its source, so an isolated
  // `build:cli` after editing thread-worker.ts never ships a stale worker.
  const stale =
    !fs.existsSync(out) || fs.statSync(out).mtimeMs < fs.statSync(src).mtimeMs;
  if (stale) {
    await buildWorker();
  }
}

// Copy the built worker bundle into dist/. dist/thread-worker.mjs is resolved by
// worker-pool-manager.ts at runtime, so the bundled cli — which spins up the
// browser pool — needs it next to its bundle.
function copyThreadWorker() {
  fs.mkdirSync(p('dist'), { recursive: true });
  fs.copyFileSync(
    p('src', 'infrastructure', 'browser', 'thread-worker.mjs'),
    p('dist', 'thread-worker.mjs'),
  );
}

// Copy the prompt templates into dist/prompts/. The bundled dist/cli.mjs resolves
// prompts relative to its own location (loadPrompt → join(dirname(cli.mjs),
// 'prompts')), so the templates must sit next to the bundle.
function copyPrompts() {
  fs.mkdirSync(p('dist', 'prompts'), { recursive: true });
  const sources = fs.readdirSync(p('src', 'prompts'));
  for (const f of sources) {
    fs.copyFileSync(p('src', 'prompts', f), p('dist', 'prompts', f));
  }
  // Prune prompts that no longer exist in src. Copying alone leaves a deleted or renamed
  // prompt behind in an incremental dist forever; verify-package rejects the orphan at
  // publish time, which surfaces as a confusing failure long after the rename.
  for (const f of fs.readdirSync(p('dist', 'prompts'))) {
    if (!sources.includes(f)) fs.rmSync(p('dist', 'prompts', f));
  }
}

const TARGETS = {
  worker: () => buildWorker(),
  cli: async () => {
    await ensureWorkerBuilt();
    await esbuild.build({
      ...COMMON,
      entryPoints: [p('src', 'cli.ts')],
      outfile: p('dist', 'cli.mjs'),
      banner: { js: SHEBANG },
    });
    copyThreadWorker();
    copyWebGpuProbe();
    copyPrompts();
  },
  skill: () => {
    const entry = p('skills', 'pi-research', 'scripts', 'run.ts');
    const outfile = p('skills', 'pi-research', 'scripts', 'run.mjs');
    // The published package ships the BUILT run.mjs and deliberately excludes its
    // run.ts source (package.json "files": "!skills/pi-research/scripts/run.ts"),
    // yet it also ships prepare.cjs + build.cjs — and `prepare` runs `build.cjs all`.
    // On any install that executes prepare against the shipped tree (npm install
    // <dir>, file:, npm link, pi install <dir>) this target had no entry point and
    // aborted the whole install with "Could not resolve run.ts". Registry .tgz and
    // npx installs were unaffected only because prepare does not run there.
    // Nothing to do when the artifact is already present and its source is not.
    if (!fs.existsSync(entry)) {
      if (fs.existsSync(outfile)) {
        console.log('[build] skill: run.ts absent and run.mjs already built (published tree) — skipping');
        return Promise.resolve();
      }
      throw new Error(`[build] skill: neither ${entry} nor a prebuilt ${outfile} exists`);
    }
    return esbuild.build({
      ...COMMON,
      entryPoints: [entry],
      outfile,
      banner: { js: SHEBANG },
    });
  },
};

// The cli target's copyThreadWorker step depends on the worker output existing,
// so the full build runs worker before cli; skill is independent.
const ALL_ORDER = ['worker', 'cli', 'skill'];

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
