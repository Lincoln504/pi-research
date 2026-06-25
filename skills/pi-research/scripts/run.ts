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
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const PKG = '@lincoln504/pi-research';
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
    if (fromDir) return fromDir;
  }

  // 3. On PATH.
  const onPath = findOnPath('pi-research');
  if (onPath) return { argv: [onPath], label: onPath };

  // 4. node_modules resolution from plausible roots.
  const pkgDir = resolvePackageDir(PKG, [skillDir, process.cwd(), home, join(home, '.pi')]);
  if (pkgDir) {
    const fromPkg = engineFromPackageDir(pkgDir);
    if (fromPkg) return fromPkg;
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

function notInstalled(): never {
  const home = homedir();
  const lines = [
    '',
    '✗ pi-research engine not found.',
    '',
    'This research skill drives the pi-research engine, but it is not installed in',
    'any of the locations this launcher checks (PATH, node_modules, ~/.pi/bin,',
    'PI_RESEARCH_PATH). Install it, then re-run:',
    '',
    '    npm install -g @lincoln504/pi-research     # global (exposes the `pi-research` bin)',
    '    # or, with pi:   pi install npm:@lincoln504/pi-research',
    '    # or point at a copy: export PI_RESEARCH_PATH=/path/to/pi-research',
    '',
    'After installing, configure a model + API key. Locations:',
    `  • env vars:           PI_RESEARCH_API_KEY / PI_RESEARCH_PROVIDER / PI_RESEARCH_MODEL`,
    `  • global config file: ${join(home, '.pi', 'research', 'config.env')}`,
    `  • pi auth storage:    ${join(home, '.pi', 'agent', 'auth.json')}`,
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

function launch(engine: ResolvedEngine): void {
  const child = spawn(engine.argv[0]!, engine.argv.slice(1).concat(argv), {
    stdio: 'inherit',
    env: process.env,
    windowsHide: true,
  });

  child.on('error', (err) => {
    process.stderr.write(`\n✗ failed to launch pi-research (${engine.label}): ${err.message}\n`);
    process.exit(EXIT.SOFTWARE);
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      process.stderr.write(`\n✗ pi-research killed by ${signal}\n`);
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
      '  node run.mjs research  "<query>" [--depth <1|2|3>] [--model provider/id]',
      '  node run.mjs knowledge "<query>" ["<q2>" ...]',
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
