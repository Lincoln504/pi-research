import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

// use-npm12.cjs is a CommonJS script (runs as a CLI in CI, exports its pure
// path logic for tests). Import it via createRequire from the ESM test.
const require = createRequire(import.meta.url);
const { binDirsFor } = require('../../../scripts/use-npm12.cjs') as {
  binDirsFor: (prefix: string, platform?: string) => string[];
};

describe('use-npm12.cjs — binDirsFor', () => {
  it('puts <prefix>/bin first on POSIX (npm global shims live there)', () => {
    expect(binDirsFor('/tmp/npm12', 'linux')).toEqual(['/tmp/npm12/bin', '/tmp/npm12']);
    expect(binDirsFor('/tmp/npm12', 'darwin')).toEqual(['/tmp/npm12/bin', '/tmp/npm12']);
  });

  it('puts the prefix itself first on Windows (npm puts the .cmd shims there)', () => {
    expect(binDirsFor('C:\\npm12', 'win32')).toEqual(['C:\\npm12', 'C:\\npm12\\bin']);
  });

  it('is host-independent: platform semantics come from the argument, not the running OS', () => {
    // The same call must return the same result whatever OS the test runs on.
    expect(binDirsFor('C:\\npm12', 'win32')).toEqual(binDirsFor('C:\\npm12', 'win32'));
    expect(binDirsFor('/tmp/npm12', 'linux')[0]).toBe('/tmp/npm12/bin');
  });
});
