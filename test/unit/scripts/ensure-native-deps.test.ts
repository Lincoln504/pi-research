/**
 * Unit tests for the CI self-heal script's pure logic (scripts/ensure-native-deps.cjs).
 *
 * The script repairs two npm/cli#4828 casualties: a dropped lancedb platform
 * binding and a silently dropped optional `@huggingface/transformers` subtree.
 * Only the decision logic is tested here — the repairs themselves shell out to
 * `npm install` and are exercised by the CI jobs that run the script.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const { optionalEmbeddingPin, resolvable, lancedbPlatformPackage } = require(
  '../../../scripts/ensure-native-deps.cjs',
) as {
  optionalEmbeddingPin: (manifestPath?: string) => { name: string; version: string } | null;
  resolvable: (name: string) => boolean;
  lancedbPlatformPackage: () => string | null;
};

// Each writeManifest() call makes a throwaway dir; collect them so this file's own teardown
// removes them (before this, each run leaked one `ensure-native-deps-*` forever).
const manifestDirs: string[] = [];

function writeManifest(body: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensure-native-deps-'));
  manifestDirs.push(dir);
  const file = path.join(dir, 'package.json');
  fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
  return file;
}

afterAll(() => {
  for (const dir of manifestDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('ensure-native-deps — optional embedding pin', () => {
  it('reads the pinned version from optionalDependencies', () => {
    const manifest = writeManifest({ optionalDependencies: { '@huggingface/transformers': '9.9.9' } });
    expect(optionalEmbeddingPin(manifest)).toEqual({ name: '@huggingface/transformers', version: '9.9.9' });
  });

  it('returns null when the embedding package is no longer declared', () => {
    const manifest = writeManifest({ optionalDependencies: { webgpu: '^0.6.0' } });
    expect(optionalEmbeddingPin(manifest)).toBeNull();
  });

  it('returns null when there are no optionalDependencies at all', () => {
    const manifest = writeManifest({ dependencies: { undici: '^8.0.0' } });
    expect(optionalEmbeddingPin(manifest)).toBeNull();
  });

  it('returns null rather than throwing on an unreadable or malformed manifest', () => {
    const malformed = writeManifest('{ not json');
    expect(optionalEmbeddingPin(malformed)).toBeNull();
    expect(optionalEmbeddingPin(path.join(os.tmpdir(), 'definitely-absent-manifest.json'))).toBeNull();
  });

  it('ignores an inherited Object.prototype key instead of treating it as declared', () => {
    // hasOwnProperty guard: a manifest whose optionalDependencies is a bare object
    // must not let 'constructor'/'toString' masquerade as the declared package.
    const manifest = writeManifest({ optionalDependencies: {} });
    expect(optionalEmbeddingPin(manifest)).toBeNull();
  });

  it('reads this repository\'s real manifest and finds the embedding pin', () => {
    const pin = optionalEmbeddingPin(path.join(process.cwd(), 'package.json'));
    expect(pin?.name).toBe('@huggingface/transformers');
    expect(pin?.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('ensure-native-deps — resolvable()', () => {
  it('resolves a package that is installed in this tree', () => {
    expect(resolvable('vitest')).toBe(true);
  });

  it('does not resolve an absent package', () => {
    expect(resolvable('@pi-research/definitely-not-installed')).toBe(false);
  });
});

describe('ensure-native-deps — lancedb platform package', () => {
  it('names a platform package or explicitly reports none for this host', () => {
    const pkg = lancedbPlatformPackage();
    if (process.platform === 'linux' || process.platform === 'win32') {
      expect(pkg).toMatch(/^@lancedb\/lancedb-/);
    } else if (process.platform === 'darwin') {
      // arm64 has a binding; Intel macOS deliberately does not.
      expect(pkg === null || pkg === '@lancedb/lancedb-darwin-arm64').toBe(true);
    } else {
      expect(pkg).toBeNull();
    }
  });
});
