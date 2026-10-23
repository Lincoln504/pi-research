import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const ROOT = join(__dirname, '..', '..', '..');
const { bareImports, unresolvableImports, installedRuntimeNames, WORKER_BUNDLES } = createRequire(import.meta.url)(join(ROOT, 'scripts', 'bare-imports.cjs'));

describe('bare-imports — standalone worker bundles must only import installed dependencies', () => {
  it('extracts bare packages from static, side-effect, re-export and dynamic imports, ignoring builtins and relatives', () => {
    const src = [
      `import a from "poolifier";`,
      `import { b } from '@scope/pkg/sub/path.js';`,
      `import "side-effect";`,
      `export { c } from "re-exported";`,
      `const d = await import("dynamic-pkg");`,
      `import fs from "node:fs"; import p from "path"; import r from "./relative.mjs"; import q from "../up.mjs";`,
    ].join('\n');
    expect([...bareImports(src)].sort()).toEqual(['@scope/pkg', 'dynamic-pkg', 'poolifier', 're-exported', 'side-effect']);
  });

  it('also sees minified imports and require() calls, but not a `.from("x")` method call', () => {
    const src = 'import{a}from"min-pkg";const b=require("cjs-pkg/sub");export*from"star-pkg";x.from("not-a-pkg-lookalike-but-matches");y.join(",");';
    expect([...bareImports(src)].sort()).toEqual(['cjs-pkg', 'min-pkg', 'star-pkg']);
  });

  it('counts dependencies and optionalDependencies as installed, and peers as not', () => {
    const names = installedRuntimeNames({ dependencies: { a: '1' }, optionalDependencies: { b: '1' }, peerDependencies: { typebox: '1' } });
    expect([...names].sort()).toEqual(['a', 'b']);
  });

  it('flags a peer import in a bundle (the v1.7.9-v1.7.18 regression)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-bare-'));
    try {
      writeFileSync(join(dir, 'w.mjs'), 'import { Type } from "typebox";\nimport p from "poolifier";\n');
      const pkg = { dependencies: { poolifier: '1' }, peerDependencies: { typebox: '1' } };
      expect(unresolvableImports(dir, pkg, ['w.mjs'])).toEqual([{ file: 'w.mjs', name: 'typebox' }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the shipped worker bundles import nothing a pi install would not have', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const present = WORKER_BUNDLES.filter((f: string) => existsSync(join(ROOT, f)));
    if (present.length === 0) return; // bundles are built by `npm run build`, not committed
    expect(unresolvableImports(ROOT, pkg)).toEqual([]);
  });
});
