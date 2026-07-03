/**
 * Ecosystem-name normalization for the vulnerability databases.
 *
 * GitHub's Advisory Database and OSV use DIFFERENT identifiers for the same package ecosystem
 * (e.g. GitHub wants `pip`/`rust`/`go`, OSV wants `PyPI`/`crates.io`/`Go`). The security tool
 * accepts one user-facing `ecosystem` value, so a name that works for one database would be
 * rejected outright by the other (GitHub 422 / OSV 400) — a guaranteed, silent lookup failure
 * for common ecosystems like Python and Rust. This maps a user-friendly value onto the exact
 * identifier each database expects. Unknown values pass through unchanged (prior behavior), so
 * this can only fix a mismatch, never introduce one.
 */

/** Canonical ecosystem key → per-database identifier. Keys are matched case-insensitively. */
const ECOSYSTEM_ALIASES: Record<string, { github: string; osv: string }> = {
  npm: { github: 'npm', osv: 'npm' },
  node: { github: 'npm', osv: 'npm' },
  pip: { github: 'pip', osv: 'PyPI' },
  pypi: { github: 'pip', osv: 'PyPI' },
  python: { github: 'pip', osv: 'PyPI' },
  maven: { github: 'maven', osv: 'Maven' },
  go: { github: 'go', osv: 'Go' },
  golang: { github: 'go', osv: 'Go' },
  cargo: { github: 'rust', osv: 'crates.io' },
  rust: { github: 'rust', osv: 'crates.io' },
  'crates.io': { github: 'rust', osv: 'crates.io' },
  nuget: { github: 'nuget', osv: 'NuGet' },
  rubygems: { github: 'rubygems', osv: 'RubyGems' },
  gem: { github: 'rubygems', osv: 'RubyGems' },
  gems: { github: 'rubygems', osv: 'RubyGems' },
  composer: { github: 'composer', osv: 'Packagist' },
  packagist: { github: 'composer', osv: 'Packagist' },
  php: { github: 'composer', osv: 'Packagist' },
  pub: { github: 'pub', osv: 'Pub' },
  dart: { github: 'pub', osv: 'Pub' },
};

/**
 * Map a user-supplied ecosystem name to the identifier the given database expects.
 * Returns the input verbatim (trimmed) when it isn't a known alias.
 */
export function normalizeEcosystem(value: string, target: 'github' | 'osv'): string {
  const key = value.trim().toLowerCase();
  const entry = ECOSYSTEM_ALIASES[key];
  return entry ? entry[target] : value.trim();
}
