import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// verify-changelog.cjs is a CommonJS script (so it can both run as a CLI and
// export its pure logic). Import it via createRequire from the ESM test.
const require = createRequire(import.meta.url);
const { parseSections, checkChangelog } = require('../../../scripts/verify-changelog.cjs') as {
  parseSections: (md: string) => Array<{ name: string; date: string | null; body: string }>;
  checkChangelog: (input: { markdown: string; version: string }) => { ok: boolean; errors: string[] };
};

const HEADER = `# Changelog\n\nAll notable changes.\n\n`;

/** Build a changelog with the given release sections, newest first. */
function changelog(sections: Array<{ version: string; date?: string | null; body?: string }>, unreleased = false): string {
  const parts = [HEADER];
  if (unreleased) parts.push(`## [Unreleased]\n\n### Changed\n\n- pending work\n\n`);
  for (const s of sections) {
    const heading = s.date === null || s.date === undefined ? `## [${s.version}]` : `## [${s.version}] - ${s.date}`;
    parts.push(`${heading}\n\n### Changed\n\n- ${s.body ?? 'something changed'}\n\n`);
  }
  return parts.join('');
}

describe('verify-changelog.cjs — parseSections', () => {
  it('parses release names and dates in document order', () => {
    const sections = parseSections(changelog([
      { version: '1.2.0', date: '2026-09-16' },
      { version: '1.1.0', date: '2026-09-01' },
    ]));
    expect(sections.map((s) => [s.name, s.date])).toEqual([
      ['1.2.0', '2026-09-16'],
      ['1.1.0', '2026-09-01'],
    ]);
  });

  it('records a null date for an undated heading and captures the body', () => {
    const sections = parseSections(changelog([{ version: '1.2.0', date: null, body: 'did a thing' }]));
    expect(sections[0].date).toBeNull();
    expect(sections[0].body).toContain('did a thing');
  });
});

describe('verify-changelog.cjs — checkChangelog', () => {
  it('passes for a dated, newest section', () => {
    const markdown = changelog([{ version: '1.2.0', date: '2026-09-16' }, { version: '1.1.0', date: '2026-09-01' }]);
    expect(checkChangelog({ markdown, version: '1.2.0' })).toEqual({ ok: true, errors: [] });
  });

  it('tolerates an [Unreleased] block above the release', () => {
    const markdown = changelog([{ version: '1.2.0', date: '2026-09-16' }], true);
    expect(checkChangelog({ markdown, version: '1.2.0' }).ok).toBe(true);
  });

  it('fails when the version has no section at all', () => {
    const markdown = changelog([{ version: '1.1.0', date: '2026-09-01' }]);
    const r = checkChangelog({ markdown, version: '1.2.0' });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('no "## [1.2.0]" section');
  });

  it('fails when the section has no date', () => {
    const markdown = changelog([{ version: '1.2.0', date: null }]);
    const r = checkChangelog({ markdown, version: '1.2.0' });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('no release date');
  });

  it('fails when the section exists but is not the newest release', () => {
    const markdown = changelog([{ version: '1.3.0', date: '2026-09-20' }, { version: '1.2.0', date: '2026-09-16' }]);
    const r = checkChangelog({ markdown, version: '1.2.0' });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('not the newest release section');
  });

  it('fails on a duplicated section', () => {
    const markdown = changelog([{ version: '1.2.0', date: '2026-09-16' }, { version: '1.2.0', date: '2026-09-16' }]);
    const r = checkChangelog({ markdown, version: '1.2.0' });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('2 "## [1.2.0]" sections');
  });

  it('fails on an empty section', () => {
    const markdown = `${HEADER}## [1.2.0] - 2026-09-16\n\n`;
    const r = checkChangelog({ markdown, version: '1.2.0' });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('empty section');
  });

  it('fails on an unparseable date', () => {
    const markdown = `${HEADER}## [1.2.0] - 2026-13-45\n\n### Changed\n\n- x\n`;
    const r = checkChangelog({ markdown, version: '1.2.0' });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('unparseable date');
  });
});

describe('verify-changelog.cjs — this repository', () => {
  it('the shipped changelog satisfies the gate for the shipped version', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    const markdown = readFileSync(path.join(root, 'docs', 'CHANGELOG.md'), 'utf8');
    const r = checkChangelog({ markdown, version });
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });
});
