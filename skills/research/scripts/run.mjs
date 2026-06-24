#!/usr/bin/env node

// skills/research/scripts/run.ts
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
var PKG = "@lincoln504/pi-research";
var EXIT = { OK: 0, USAGE: 64, CONFIG: 78, SOFTWARE: 70 };
var argv = process.argv.slice(2);
var subcommand = argv[0];
if (!subcommand || subcommand === "-h" || subcommand === "--help" || subcommand === "help") {
  printUsage();
  process.exit(EXIT.OK);
}
var require2 = createRequire(import.meta.url);
function resolvePackageDir(specifier, roots) {
  const candidates = [
    ...process.cwd() !== roots[0] ? [process.cwd()] : [],
    ...roots
  ];
  for (const root of candidates) {
    try {
      const pkgJson = require2.resolve(`${specifier}/package.json`, { paths: [root] });
      return dirname(pkgJson);
    } catch {
    }
  }
  try {
    const pkgJson = require2.resolve(`${specifier}/package.json`);
    return dirname(pkgJson);
  } catch {
    return null;
  }
}
function findOnPath(bin) {
  const pathVar = process.env["PATH"] ?? "";
  const exts = process.platform === "win32" ? (process.env["PATHEXT"] ?? ".EXE;.CMD").split(";") : [""];
  for (const dir of pathVar.split(process.platform === "win32" ? ";" : ":")) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, bin + ext);
      try {
        if (existsSync(candidate)) return candidate;
      } catch {
      }
    }
  }
  return null;
}
function resolveEngine(skillDir) {
  const home = homedir();
  if (process.env["PI_RESEARCH_BIN"] && existsSync(process.env["PI_RESEARCH_BIN"])) {
    return { argv: [process.env["PI_RESEARCH_BIN"]], label: process.env["PI_RESEARCH_BIN"] };
  }
  const explicitPath = process.env["PI_RESEARCH_PATH"];
  if (explicitPath) {
    const fromDir = engineFromPackageDir(explicitPath);
    if (fromDir) return fromDir;
  }
  const onPath = findOnPath("pi-research");
  if (onPath) return { argv: [onPath], label: onPath };
  const pkgDir = resolvePackageDir(PKG, [skillDir, process.cwd(), home, join(home, ".pi")]);
  if (pkgDir) {
    const fromPkg = engineFromPackageDir(pkgDir);
    if (fromPkg) return fromPkg;
  }
  const piBin = join(home, ".pi", "bin", "pi-research");
  if (existsSync(piBin)) return { argv: [piBin], label: piBin };
  return null;
}
function engineFromPackageDir(pkgDir) {
  try {
    const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf-8"));
    const binField = typeof pkg?.bin === "string" ? pkg.bin : pkg?.bin?.["pi-research"];
    if (binField) {
      const binPath = join(pkgDir, binField);
      if (existsSync(binPath)) {
        const isJsModule = /\.(m|c)?js$/i.test(binField);
        return isJsModule ? { argv: [process.execPath, binPath], label: binPath } : { argv: [binPath], label: binPath };
      }
    }
  } catch {
  }
  const cliPath = join(pkgDir, "dist", "cli.mjs");
  if (existsSync(cliPath)) {
    return { argv: [process.execPath, cliPath], label: cliPath };
  }
  return null;
}
function notInstalled() {
  const home = homedir();
  const lines = [
    "",
    "\u2717 pi-research engine not found.",
    "",
    "This research skill drives the pi-research engine, but it is not installed in",
    "any of the locations this launcher checks (PATH, node_modules, ~/.pi/bin,",
    "PI_RESEARCH_PATH). Install it, then re-run:",
    "",
    "    npm install -g @lincoln504/pi-research     # global (exposes the `pi-research` bin)",
    "    # or, with pi:   pi install npm:@lincoln504/pi-research",
    "    # or point at a copy: export PI_RESEARCH_PATH=/path/to/pi-research",
    "",
    "After installing, configure a model + API key. Locations:",
    `  \u2022 env vars:           PI_RESEARCH_API_KEY / PI_RESEARCH_PROVIDER / PI_RESEARCH_MODEL`,
    `  \u2022 global config file: ${join(home, ".pi", "research", "config.env")}`,
    `  \u2022 pi auth storage:    ${join(home, ".pi", "agent", "auth.json")}`,
    "",
    "Run `status` once installed to verify detection.",
    ""
  ];
  process.stderr.write(lines.join("\n"));
  process.exit(EXIT.CONFIG);
}
function launch(engine2) {
  const child = spawn(engine2.argv[0], engine2.argv.slice(1).concat(argv), {
    stdio: "inherit",
    env: process.env,
    windowsHide: true
  });
  child.on("error", (err) => {
    process.stderr.write(`
\u2717 failed to launch pi-research (${engine2.label}): ${err.message}
`);
    process.exit(EXIT.SOFTWARE);
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      process.stderr.write(`
\u2717 pi-research killed by ${signal}
`);
      process.exit(EXIT.SOFTWARE);
    }
    process.exit(code ?? EXIT.SOFTWARE);
  });
}
function printUsage() {
  process.stdout.write(
    [
      "research skill \u2014 pi-research launcher",
      "",
      "USAGE",
      '  node run.mjs research  "<query>" [--depth <1|2|3>] [--model provider/id]',
      '  node run.mjs knowledge "<query>" ["<q2>" ...]',
      "  node run.mjs status [--json]",
      "",
      "This locates the installed pi-research engine and forwards the subcommand to it.",
      "If the engine is missing, it prints install/config instructions and exits 78.",
      ""
    ].join("\n")
  );
}
var here = dirname(fileURLToPath(import.meta.url));
var engine = resolveEngine(here);
if (!engine) notInstalled();
launch(engine);
