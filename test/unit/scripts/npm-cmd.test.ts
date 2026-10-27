import { describe, it, expect, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Unit tests for the shell-less npm resolver (scripts/lib/npm-cmd.cjs).
 *
 * The resolver exists because a bare `npm` argv spawn is unresolvable on
 * Windows (the npm on PATH is a `.cmd` shim; direct `.cmd` spawns are
 * rejected since CVE-2024-27980), and a shell would re-parse the argv the
 * hardening removed. It must therefore hand back an absolute, shell-free
 * invocation — and every branch must be testable without a Windows host.
 */
const require = createRequire(import.meta.url);
const { npmCliCandidates, npmInvocation } = require('../../../scripts/lib/npm-cmd.cjs') as {
  npmCliCandidates: (execPath: string, platform?: string) => string[];
  npmInvocation: (execPath?: string) => { command: string; args: string[] };
};

const dirs: string[] = [];
function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-cmd-'));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('npm-cmd.cjs — npmCliCandidates', () => {
  it('checks the nodejs.org/CI layout first and the nvm/Homebrew layout second (host paths)', () => {
    const c = npmCliCandidates(process.execPath);
    expect(c).toHaveLength(2);
    expect(c[0]).toBe(path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    expect(c[1]).toBe(
      path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    );
  });

  it('is host-independent: the Windows layout comes from the platform argument, not the running OS', () => {
    const c = npmCliCandidates('C:\\node\\node.exe', 'win32');
    expect(c[0]).toBe('C:\\node\\node_modules\\npm\\bin\\npm-cli.js');
    // path.win32 normalizes `C:\node\..` to `C:\`, so the second candidate
    // is the parent directory's lib — the point is that the layout is
    // platform-derived, not host-derived.
    expect(c[1]).toBe('C:\\lib\\node_modules\\npm\\bin\\npm-cli.js');
    // Same input, same platform, same result — whatever OS runs the test.
    expect(npmCliCandidates('C:\\node\\node.exe', 'win32')).toEqual(c);
  });
});

describe('npm-cmd.cjs — npmInvocation', () => {
  it('resolves the bundled npm CLI on the running host (no shim, no shell)', () => {
    const inv = npmInvocation();
    expect(inv.command).toBe(process.execPath);
    expect(inv.args).toHaveLength(1);
    expect(inv.args[0].endsWith(path.join('npm', 'bin', 'npm-cli.js'))).toBe(true);
    expect(fs.existsSync(inv.args[0])).toBe(true);
  });

  it('prefers the nodejs.org layout when both layouts exist', () => {
    const dir = mkTmp();
    // Node binary at <dir>/bin/node: candidate 1 is <dir>/bin/node_modules/..., candidate 2 is <dir>/lib/... — both inside the throwaway dir.
    const flat = path.join(dir, 'bin', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const lib = path.join(dir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    fs.mkdirSync(path.dirname(flat), { recursive: true });
    fs.mkdirSync(path.dirname(lib), { recursive: true });
    fs.writeFileSync(flat, '');
    fs.writeFileSync(lib, '');
    const inv = npmInvocation(path.join(dir, 'bin', 'node'));
    expect(inv).toEqual({ command: path.join(dir, 'bin', 'node'), args: [flat] });
  });

  it('finds the nvm/Homebrew layout when only that exists', () => {
    const dir = mkTmp();
    const lib = path.join(dir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    fs.mkdirSync(path.dirname(lib), { recursive: true });
    fs.writeFileSync(lib, '');
    const inv = npmInvocation(path.join(dir, 'bin', 'node'));
    expect(inv).toEqual({ command: path.join(dir, 'bin', 'node'), args: [lib] });
  });

  it('falls back to the bare npm name when no bundled CLI exists (a non-standard Node build)', () => {
    const dir = mkTmp();
    expect(npmInvocation(path.join(dir, 'node'))).toEqual({ command: 'npm', args: [] });
  });
});
