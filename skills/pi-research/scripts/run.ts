/**
 * research skill — portable launcher (resolver + spawner)
 *
 * Zero-dependency Node script bundled to run.mjs. It locates the installed
 * pi-research engine and runs the requested subcommand, streaming its output.
 *
 * Why a launcher instead of calling `pi-research` directly from the agent?
 *   - The engine can be installed globally (npm i -g), locally (node_modules),
 *     via pi (~/.pi/bin), or pointed at with PI_RESEARCH_PATH. This launcher
 *     finds it in all of those places so the skill works regardless of how the
 *     user installed it.
 *   - If the engine is NOT installed, this launcher prints a single clean,
 *     actionable error (with install + config locations) and exits 78 — instead
 *     of a raw "command not found" that the agent would have to interpret.
 *
 * The engine itself (dist/cli.mjs) does the model/key detection and research.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const PKG = '@lincoln504/pi-research';
// Load-bearing runtime dependency of the engine: the standalone CLI statically
// imports it (model registry + auth + agent dir). On an install that omitted
// it, it would die at module-load with a raw ERR_MODULE_NOT_FOUND; we preflight
// it here so the user gets the same clean, actionable exit-78 message as a missing
// engine instead of a stack trace.
const REQUIRED_DEP = '@earendil-works/pi-coding-agent';
const EXIT = { OK: 0, USAGE: 64, CONFIG: 78, SOFTWARE: 70 } as const;

// ---------------------------------------------------------------------------
// Argument plumbing (subcommand passthrough to the engine)
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const subcommand = argv[0];

if (!subcommand || subcommand === '-h' || subcommand === '--help' || subcommand === 'help') {
  printUsage();
  process.exit(EXIT.OK);
}

// ---------------------------------------------------------------------------
// Engine resolution
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url);

/** Resolve a package's directory by specifier, searching extra roots. */
function resolvePackageDir(specifier: string, roots: string[]): string | null {
  const candidates = [
    ...(process.cwd() !== roots[0] ? [process.cwd()] : []),
    ...roots,
  ];
  for (const root of candidates) {
    try {
      // require.resolve with `paths` searches node_modules under each root.
      const pkgJson = require.resolve(`${specifier}/package.json`, { paths: [root] });
      return dirname(pkgJson);
    } catch {
      // try next root
    }
  }
  // Last-ditch: bare specifier resolution (honors NODE_PATH, symlinks, etc.).
  try {
    const pkgJson = require.resolve(`${specifier}/package.json`);
    return dirname(pkgJson);
  } catch {
    return null;
  }
}

/** Try to find an executable on PATH. */
function findOnPath(bin: string): string | null {
  const pathVar = process.env['PATH'] ?? '';
  const exts = process.platform === 'win32' ? (process.env['PATHEXT'] ?? '.EXE;.CMD').split(';') : [''];
  for (const dir of pathVar.split(process.platform === 'win32' ? ';' : ':')) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, bin + ext);
      try {
        if (existsSync(candidate)) return candidate;
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

interface ResolvedEngine {
  /** How to launch: ['node', cliPath] or [binPath]. */
  argv: string[];
  label: string;
}

/**
 * Find the pi-research engine. Resolution order:
 *   1. PI_RESEARCH_BIN  → an explicit executable path
 *   2. PI_RESEARCH_PATH → a package directory (uses its dist/cli.mjs or bin)
 *   3. `pi-research` on PATH (global/local install exposes a bin)
 *   4. node_modules resolution from: skill dir, CWD, home, ~/.pi (package dir)
 *   5. ~/.pi/bin/pi-research (where `pi install` exposes bins)
 */
function resolveEngine(skillDir: string): ResolvedEngine | null {
  const home = homedir();

  // 1. Explicit executable.
  if (process.env['PI_RESEARCH_BIN'] && existsSync(process.env['PI_RESEARCH_BIN'])) {
    return { argv: [process.env['PI_RESEARCH_BIN']!], label: process.env['PI_RESEARCH_BIN']! };
  }

  // 2. Explicit package dir.
  const explicitPath = process.env['PI_RESEARCH_PATH'];
  if (explicitPath) {
    const fromDir = engineFromPackageDir(explicitPath);
    if (fromDir) {
      if (!depResolvableFrom(explicitPath)) depMissing(explicitPath);
      return fromDir;
    }
  }

  // 3. On PATH.
  const onPath = findOnPath('pi-research');
  if (onPath) return { argv: [onPath], label: onPath };

  // 4. node_modules resolution from plausible roots.
  const pkgDir = resolvePackageDir(PKG, [skillDir, process.cwd(), home, join(home, '.pi')]);
  if (pkgDir) {
    const fromPkg = engineFromPackageDir(pkgDir);
    if (fromPkg) {
      // We resolved the engine via its package dir, so we can verify its
      // dependency resolves from the same anchor (where the bundled CLI looks).
      if (!depResolvableFrom(pkgDir)) depMissing(pkgDir);
      return fromPkg;
    }
  }

  // 5. pi's bin directory.
  const piBin = join(home, '.pi', 'bin', 'pi-research');
  if (existsSync(piBin)) return { argv: [piBin], label: piBin };

  return null;
}

/** Given a package directory, derive how to launch its CLI (bin or dist/cli.mjs). */
function engineFromPackageDir(pkgDir: string): ResolvedEngine | null {
  // Prefer the declared bin (reads package.json `bin`).
  try {
    const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf-8'));
    const binField = typeof pkg?.bin === 'string' ? pkg.bin : pkg?.bin?.['pi-research'];
    if (binField) {
      const binPath = join(pkgDir, binField);
      if (existsSync(binPath)) {
        // .js / .mjs / .cjs files are not directly executable; they require node.
        // (npm only creates a runnable wrapper in the global bin on `npm install -g`.)
        const isJsModule = /\.(m|c)?js$/i.test(binField);
        return isJsModule
          ? { argv: [process.execPath, binPath], label: binPath }
          : { argv: [binPath], label: binPath };
      }
    }
  } catch {
    /* fall through */
  }
  // Fallback: the compiled CLI shipped at dist/cli.mjs.
  const cliPath = join(pkgDir, 'dist', 'cli.mjs');
  if (existsSync(cliPath)) {
    return { argv: [process.execPath, cliPath], label: cliPath };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Is the engine's load-bearing runtime dependency physically present, reachable
 * from `anchorDir`? We check for node_modules/<REQUIRED_DEP>/package.json walking
 * up parent dirs (Node's package-lookup algorithm) rather than require.resolve(),
 * because it is an ESM package with conditional `exports` and no CJS/package.json
 * export — require.resolve() from this CJS launcher throws "No exports main
 * defined" even when it is installed and the engine imports it fine. Checking the
 * directory mirrors how Node finds the package, immune to export conditions.
 */
function depResolvableFrom(anchorDir: string): boolean {
  const depSegs = REQUIRED_DEP.split('/');
  // Normalize: a relative anchor would otherwise stop the walk at '.' and miss
  // hoisted node_modules in real parent dirs, wrongly reporting the dependency missing.
  let dir = resolve(anchorDir);
  for (;;) {
    if (existsSync(join(dir, 'node_modules', ...depSegs, 'package.json'))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

function depMissing(pkgDir: string): never {
  const lines = [
    '',
    `Error: pi-research engine found, but its required runtime dependency`,
    `'${REQUIRED_DEP}' is not installed alongside it.`,
    '',
    'The standalone engine imports this package at startup, so it cannot run',
    'without it. Reinstall so all dependencies are included:',
    '',
    '    npm install -g @lincoln504/pi-research     # global — reinstalls the full dependency tree',
    `    # or, in the package dir:  cd "${pkgDir}" && npm install ${REQUIRED_DEP}`,
    '',
    `(engine located at: ${pkgDir})`,
    '',
  ];
  process.stderr.write(lines.join('\n'));
  process.exit(EXIT.CONFIG);
}

function notInstalled(): never {
  const home = homedir();
  const lines = [
    '',
    'Error: pi-research engine not found.',
    '',
    'This research skill drives the pi-research engine, but it is not installed in',
    'any of the locations this launcher checks (PATH, node_modules, ~/.pi/bin,',
    'PI_RESEARCH_PATH). Install it, then re-run:',
    '',
    '    npm install -g @lincoln504/pi-research     # global (exposes the `pi-research` bin)',
    '    # or, with pi:   pi install npm:@lincoln504/pi-research',
    '    # or point at a copy: export PI_RESEARCH_PATH=/path/to/pi-research',
    '',
    'After installing, configure the model (PI_RESEARCH_MODEL is required) + API key.',
    'Locations:',
    `  • env vars:           PI_RESEARCH_API_KEY / PI_RESEARCH_PROVIDER / PI_RESEARCH_MODEL`,
    `  • global config file: ${join(home, '.pi', 'research', 'config.env')}`,
    `  • pi auth storage:    ${join(home, '.pi', 'agent', 'auth.json')}  (supplies the API key only)`,
    '',
    'Run `status` once installed to verify detection.',
    '',
  ];
  process.stderr.write(lines.join('\n'));
  process.exit(EXIT.CONFIG);
}

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

/** True if a string carries cmd.exe metacharacters that shell:true would interpret.
 * Includes \r\n: quote state does not survive a line break in the /c command string,
 * so an embedded newline acts as a command separator. */
function hasCmdMetachar(s: string): boolean {
  return /[&|<>^"%()!\r\n]/.test(s);
}

/**
 * Given a Windows .cmd/.bat shim, resolve the underlying `node <cli.mjs>` invocation
 * so we can run it directly WITHOUT a shell. npm/pi place the package under
 * <binDir>/node_modules/<PKG> next to the shim; as a fallback we parse the node_modules
 * path the shim itself embeds. Returns null if we can't find the JS entry.
 */
function resolveWinShimToNode(shimPath: string): ResolvedEngine | null {
  const fromLayout = engineFromPackageDir(join(dirname(shimPath), 'node_modules', ...PKG.split('/')));
  if (fromLayout && fromLayout.argv[0] === process.execPath) return fromLayout;
  try {
    const content = readFileSync(shimPath, 'utf-8');
    const m = content.match(/node_modules[\\/][^"\r\n]*?\.(?:mjs|cjs|js)\b/i);
    if (m) {
      const abs = resolve(dirname(shimPath), m[0]);
      if (existsSync(abs)) return { argv: [process.execPath, abs], label: abs };
    }
  } catch { /* fall through to null */ }
  return null;
}

function launch(engine: ResolvedEngine): void {
  let target = engine.argv[0]!;
  let runArgv = engine.argv.slice(1).concat(argv);
  let useShell = false;

  // On Windows the resolved binary may be an npm batch shim (pi-research.cmd) found
  // via PATH/PATHEXT for a global install. Since the Node CVE-2024-27980 fix, spawning
  // a .cmd/.bat WITHOUT shell:true throws EINVAL — but shell:true routes the (untrusted)
  // research query through cmd.exe, where an unescaped `&`/`|`/`%VAR%`/`^` is a command-
  // injection vector. So prefer running the shim's underlying `node <cli.mjs>` directly
  // (no shell); only fall back to the shell for a shim we can't bypass, and then only
  // when the args are metacharacter-free — otherwise refuse rather than run unsafely.
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(target)) {
    const direct = resolveWinShimToNode(target);
    if (direct) {
      target = direct.argv[0]!;
      runArgv = direct.argv.slice(1).concat(argv);
    } else if (argv.some(hasCmdMetachar)) {
      process.stderr.write(
        '\nError: cannot safely pass this query to the Windows pi-research.cmd shim — it ' +
        'contains shell metacharacters (& | < > ^ " % ( ) !).\nSet PI_RESEARCH_BIN to the ' +
        "engine's node CLI (…\\dist\\cli.mjs) or PI_RESEARCH_PATH to its package dir, then re-run.\n",
      );
      process.exit(EXIT.CONFIG);
    } else {
      useShell = true;
    }
  }

  // shell:true performs NO quoting, so a spaced shim path or a multi-word query would
  // be word-split by cmd.exe. The metacharacter guard above already refused anything
  // containing `"` (and every other cmd.exe special), so plain double-quoting each
  // token is safe and cannot itself be escaped out of.
  const child = spawn(
    useShell ? `"${target}"` : target,
    useShell ? runArgv.map((a) => `"${a}"`) : runArgv,
    {
      stdio: 'inherit',
      env: process.env,
      windowsHide: true,
      ...(useShell ? { shell: true } : {}),
    },
  );

  child.on('error', (err) => {
    process.stderr.write(`\nError: failed to launch pi-research (${engine.label}): ${err.message}\n`);
    process.exit(EXIT.SOFTWARE);
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      process.stderr.write(`\nError: pi-research killed by ${signal}\n`);
      process.exit(EXIT.SOFTWARE);
    }
    process.exit(code ?? EXIT.SOFTWARE);
  });
}

function printUsage(): void {
  process.stdout.write(
    [
      'research skill — pi-research launcher',
      '',
      'USAGE',
      '  node run.mjs research  "<query>" [--depth <0|1|2|3>] [--model provider/id]',
      '  node run.mjs knowledge "<query>" ["<q2>" ...]',
      '  node run.mjs knowledge-config [set <none|project|global>]',
      '  node run.mjs status [--json]',
      '',
      'This locates the installed pi-research engine and forwards the subcommand to it.',
      'If the engine is missing, it prints install/config instructions and exits 78.',
      '',
    ].join('\n'),
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const engine = resolveEngine(here);
if (!engine) notInstalled();
launch(engine!);
