import { describe, it, expect } from 'vitest';
import { normalizeEcosystem } from '../../../src/security/ecosystem.ts';

describe('normalizeEcosystem — per-database ecosystem identifiers', () => {
  it('maps Rust aliases to each database\'s identifier (GitHub=rust, OSV=crates.io)', () => {
    for (const alias of ['cargo', 'rust', 'crates.io', 'CARGO']) {
      expect(normalizeEcosystem(alias, 'github')).toBe('rust');
      expect(normalizeEcosystem(alias, 'osv')).toBe('crates.io');
    }
  });

  it('maps Python aliases (GitHub=pip, OSV=PyPI)', () => {
    for (const alias of ['pip', 'pypi', 'python', 'PyPI']) {
      expect(normalizeEcosystem(alias, 'github')).toBe('pip');
      expect(normalizeEcosystem(alias, 'osv')).toBe('PyPI');
    }
  });

  it('maps the case-sensitive OSV names for go/maven/nuget/rubygems/composer/pub', () => {
    expect(normalizeEcosystem('go', 'osv')).toBe('Go');
    expect(normalizeEcosystem('golang', 'osv')).toBe('Go');
    expect(normalizeEcosystem('maven', 'osv')).toBe('Maven');
    expect(normalizeEcosystem('nuget', 'osv')).toBe('NuGet');
    expect(normalizeEcosystem('gem', 'osv')).toBe('RubyGems');
    expect(normalizeEcosystem('packagist', 'osv')).toBe('Packagist');
    expect(normalizeEcosystem('dart', 'osv')).toBe('Pub');
  });

  it('leaves npm unchanged for both databases', () => {
    expect(normalizeEcosystem('npm', 'github')).toBe('npm');
    expect(normalizeEcosystem('npm', 'osv')).toBe('npm');
  });

  it('passes an unknown ecosystem through unchanged (trimmed) — never introduces a mismatch', () => {
    expect(normalizeEcosystem('  some-new-ecosystem ', 'github')).toBe('some-new-ecosystem');
    expect(normalizeEcosystem('some-new-ecosystem', 'osv')).toBe('some-new-ecosystem');
  });
});
