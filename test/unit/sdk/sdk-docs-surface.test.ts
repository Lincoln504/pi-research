/**
 * The SDK's documented surface must not fall behind its actual one.
 *
 * docs/SDK.md drifted to covering roughly a quarter of what src/sdk.ts exports:
 * runResearchDetailed, scrapeUrl, verifyUrl, exportKnowledge, the four getLast*
 * accessors and getSessionMetrics were all public and all unmentioned, so callers had
 * no way to discover them short of reading the source. This test keeps the reference
 * honest — adding an export without documenting it fails here.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SDK_SRC = fs.readFileSync(path.join(ROOT, 'src/sdk.ts'), 'utf8');
const SDK_DOC = fs.readFileSync(path.join(ROOT, 'docs/SDK.md'), 'utf8');

function exportedNames(src: string): string[] {
  return [
    ...[...src.matchAll(/^export (?:async )?function (\w+)/gm)].map(m => m[1]!),
    ...[...src.matchAll(/^export interface (\w+)/gm)].map(m => m[1]!),
  ];
}

describe('docs/SDK.md tracks the SDK export surface', () => {
  it('documents every function and type src/sdk.ts exports', () => {
    const names = exportedNames(SDK_SRC);
    // Guard against a vacuous pass if the export style ever changes.
    expect(names.length).toBeGreaterThanOrEqual(20);

    const mentioned = new Set([...SDK_DOC.matchAll(/`([A-Za-z_]\w*)`/g)].map(m => m[1]!));
    const undocumented = names.filter(n => !mentioned.has(n));
    expect(undocumented).toEqual([]);
  });

  it('gives every exported function a signature row in the API reference', () => {
    const rows = new Set([...SDK_DOC.matchAll(/^\| `(\w+)` \| `/gm)].map(m => m[1]!));
    const fns = [...SDK_SRC.matchAll(/^export (?:async )?function (\w+)/gm)].map(m => m[1]!);
    expect(fns.filter(n => !rows.has(n))).toEqual([]);
  });

  it('does not document exports that no longer exist', () => {
    const known = new Set(exportedNames(SDK_SRC));
    // Only signature rows are checked — the init-options table documents option names
    // rather than exports, and is excluded by requiring a second column that opens a
    // call signature.
    const signatureRows = [...SDK_DOC.matchAll(/^\| `(\w+)` \| `\(/gm)].map(m => m[1]!);
    expect(signatureRows.length).toBeGreaterThanOrEqual(15);
    expect(signatureRows.filter(n => !known.has(n))).toEqual([]);
  });
});
