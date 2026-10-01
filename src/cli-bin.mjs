#!/usr/bin/env node
/**
 * The installed `pi-research` bin.
 *
 * WHY THIS SHIM EXISTS INSTEAD OF POINTING `bin` STRAIGHT AT dist/cli.mjs
 *
 * dist/cli.mjs statically imports the `@earendil-works/pi-*` host packages, which
 * are declared as PEER dependencies: pi supplies its own copies when it loads
 * this package as an extension, and npm >= 7 resolves them automatically for a
 * standalone (global or project) install. An install that skips peers leaves
 * them absent — `npm install --legacy-peer-deps`, yarn classic, and a pnpm
 * config with `auto-install-peers=false` all do that — and Node then dies at
 * module load with a raw `ERR_MODULE_NOT_FOUND` stack before any of our code
 * runs. The user sees an internal Node error instead of the one-line fix.
 *
 * The preflight cannot live inside the bundle: esbuild hoists the bundle's
 * external `import` declarations to the very top of the output file, ahead of
 * every statement in the program, so anything the bundle body does runs AFTER
 * the failing import has already thrown. (Verified: a wrapper entry point whose
 * first statement is the preflight still crashes, because the emitted file
 * begins with `import "…/pi-ai";`.) It has to be a separate module, which is
 * why this file is shipped unbundled and why `bin` points at it.
 *
 * The check uses `import.meta.resolve()`, NOT `createRequire().resolve()`: both
 * host packages are ESM-only (`exports` maps with no `require` condition), so
 * the CJS resolver fails on them with `ERR_PACKAGE_PATH_NOT_EXPORTED` even when
 * they are correctly installed — a false negative that would break every
 * healthy install. `import.meta.resolve()` uses the same ESM resolution the
 * bundle itself uses, returns when the package is present, and throws
 * `ERR_MODULE_NOT_FOUND` when it is not.
 *
 * Exit code 78 (EXIT.CONFIG) and the remedy text match the agent-skill
 * launcher's `depMissing()` — one failure, one message, whichever entry point
 * the user reached for.
 */

import { fileURLToPath } from 'node:url';

const REQUIRED_PEERS = ['@earendil-works/pi-ai', '@earendil-works/pi-coding-agent'];

const missing = REQUIRED_PEERS.filter((name) => {
  try {
    import.meta.resolve(name);
    return false;
  } catch {
    return true;
  }
});

if (missing.length > 0) {
  const lines = [
    '',
    'Error: pi-research cannot start — it is missing required runtime dependencies:',
    ...missing.map((name) => `    ${name}`),
    '',
    'These are PEER dependencies. pi provides its own copies when it loads this',
    'package as an extension, and npm >= 7 installs them automatically for a',
    'standalone (global or project) install. This install skipped them, which is',
    'what --legacy-peer-deps, yarn classic, and a pnpm config with',
    'auto-install-peers=false do.',
    '',
    'Either of these fixes it:',
    '',
    '    npm install -g @earendil-works/pi-coding-agent   # add just the missing host package',
    '    npm install -g @lincoln504/pi-research           # or reinstall, resolving peers',
    '',
  ];
  process.stderr.write(lines.join('\n'));
  process.exit(78);
}

// dist/cli.mjs decides whether to run by comparing its own module URL against
// process.argv[1]. Because this shim is what the OS (or npm's Windows .cmd shim)
// actually invokes, argv[1] is THIS file; without the rewrite below that check
// would be false and the CLI would exit 0 having done nothing at all. Point it
// at the real entry point before importing it, so both sides resolve to the
// same realpath.
//
// fileURLToPath, not URL.pathname: on Windows the latter yields
// `/C:/…/cli.mjs`, which is not a path any filesystem call accepts.
process.argv[1] = fileURLToPath(new URL('./cli.mjs', import.meta.url));

await import('./cli.mjs');
