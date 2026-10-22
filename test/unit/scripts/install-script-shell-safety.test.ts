import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The install-time scripts (postinstall, preinstall cleanup, prepare) run with the
 * user's privileges the moment `npm install` finishes, from a directory whose NAME the
 * user (or a git-install path) controls. A shell string built from a path under that
 * directory executes `$(...)` and backticks in the name; an argv array cannot.
 * prepare.cjs, setup.cjs's browser fetch and cleanup.cjs already used argv arrays;
 * setup.cjs's `install-deps` call was the lone holdout (`execSync(`"${cli}" ...`)`).
 */
const SCRIPTS = path.join(__dirname, '../../../scripts');
const INSTALL_TIME = ['setup.cjs', 'cleanup.cjs', 'prepare.cjs', 'build.cjs', 'camoufox-layout.cjs'];

describe('install-time scripts never build shell strings', () => {
  for (const name of INSTALL_TIME) {
    it(`${name} uses no execSync / exec / shell:true`, () => {
      const src = fs.readFileSync(path.join(SCRIPTS, name), 'utf8')
        // Comments may legitimately discuss the forbidden forms.
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(src).not.toMatch(/\bexecSync\s*\(/);
      expect(src).not.toMatch(/\bexec\s*\(/);
      expect(src).not.toMatch(/shell\s*:\s*true/);
    });
  }
});
