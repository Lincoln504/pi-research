import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

// audit-gate.cjs is a CommonJS script (so it can both run as a CLI and export
// its pure matching logic). Import it via createRequire from the ESM test.
const require = createRequire(import.meta.url);
const {
  classifyAdvisories,
  validateExceptions,
  locationMatch,
} = require('../../../scripts/audit-gate.cjs') as {
  classifyAdvisories: (
    auditJson: unknown,
    exceptions: unknown[],
  ) => { excepted: Array<{ id: string; packages: string[]; nodes: string[]; reason?: string }>; blocking: Array<{ id: string; packages: string[] }>; stale: string[] };
  validateExceptions: (exceptions: unknown) => void;
  locationMatch: (adv: { packages: Set<string>; nodes: Set<string> }, locationExceptions: unknown[]) => unknown;
};

/** Build a minimal npm-audit --json vulnerabilities entry for one advisory. */
function auditFor(pkg: string, ghsa: string, nodes: string[] = [], severity = 'high'): Record<string, unknown> {
  return {
    vulnerabilities: {
      [pkg]: {
        nodes,
        via: [{ name: pkg, url: `https://github.com/advisories/${ghsa}`, severity, title: `${pkg} test advisory` }],
      },
    },
  };
}

const BASE_EXC = { reason: 'r', clearsWhen: 'c', reviewed: '2026-08-03' };

describe('audit-gate.cjs — classifyAdvisories', () => {
  describe('per-GHSA exceptions', () => {
    it('allowlists the one advisory whose GHSA id matches', () => {
      const audit = auditFor('somepkg', 'GHSA-aaaa-aaaa-aaaa');
      const { excepted, blocking } = classifyAdvisories(audit, [{ id: 'GHSA-aaaa-aaaa-aaaa', package: 'somepkg', ...BASE_EXC }]);
      expect(blocking).toHaveLength(0);
      expect(excepted).toHaveLength(1);
      expect(excepted[0]!.id).toBe('GHSA-aaaa-aaaa-aaaa');
    });

    it('blocks an advisory with no matching exception', () => {
      const audit = auditFor('somepkg', 'GHSA-bbbb-bbbb-bbbb');
      const { blocking } = classifyAdvisories(audit, [{ id: 'GHSA-aaaa-aaaa-aaaa', package: 'somepkg', ...BASE_EXC }]);
      expect(blocking).toHaveLength(1);
    });
  });

  describe('location-scoped exceptions — the safety property', () => {
    const locExc = [{ package: 'undici', locationContains: '@earendil-works/pi-coding-agent', ...BASE_EXC }];

    it('matches when the ONLY affected copy is in the scoped (upstream-blocked) location', () => {
      const audit = auditFor('undici', 'GHSA-loc1', ['node_modules/@earendil-works/pi-coding-agent/node_modules/undici']);
      const { excepted, blocking } = classifyAdvisories(audit, locExc);
      expect(blocking).toHaveLength(0);
      expect(excepted).toHaveLength(1);
      expect(excepted[0]!.reason).toContain('location-scoped');
    });

    it('does NOT match (blocks) when a remediable copy is ALSO affected — cannot mask a fixable vuln', () => {
      // This is the core safety guarantee: jsdom's undici is remediable here, so a
      // disclosure hitting both copies must NOT be auto-allowlisted.
      const audit = auditFor('undici', 'GHSA-loc2', [
        'node_modules/@earendil-works/pi-coding-agent/node_modules/undici',
        'node_modules/jsdom/node_modules/undici',
      ]);
      const { blocking } = classifyAdvisories(audit, locExc);
      expect(blocking).toHaveLength(1);
    });

    it('does NOT match (blocks) when only a remediable (non-scoped) copy is affected', () => {
      const audit = auditFor('undici', 'GHSA-loc3', ['node_modules/jsdom/node_modules/undici']);
      const { blocking } = classifyAdvisories(audit, locExc);
      expect(blocking).toHaveLength(1);
    });

    it('does NOT match (blocks) when only the top-level (remediable) copy is affected', () => {
      const audit = auditFor('undici', 'GHSA-loc4', ['node_modules/undici']);
      const { blocking } = classifyAdvisories(audit, locExc);
      expect(blocking).toHaveLength(1);
    });

    it('does NOT match (blocks) when there is no install-path info (fail safe)', () => {
      const audit = auditFor('undici', 'GHSA-loc5', []); // no nodes
      const { blocking } = classifyAdvisories(audit, locExc);
      expect(blocking).toHaveLength(1);
    });

    it('does NOT match when the package differs (wrong package at the scoped location)', () => {
      const audit = auditFor('sharp', 'GHSA-loc6', ['node_modules/@earendil-works/pi-coding-agent/node_modules/sharp']);
      const { blocking } = classifyAdvisories(audit, locExc);
      expect(blocking).toHaveLength(1);
    });

    it('per-GHSA exception takes precedence over a non-matching location scope', () => {
      const audit = auditFor('undici', 'GHSA-loc7', ['node_modules/jsdom/node_modules/undici']);
      const { excepted, blocking } = classifyAdvisories(audit, [
        { id: 'GHSA-loc7', package: 'undici', ...BASE_EXC },
        ...locExc,
      ]);
      expect(blocking).toHaveLength(0);
      expect(excepted).toHaveLength(1);
    });
  });

  describe('severity threshold', () => {
    it('ignores advisories below the moderate threshold (low/info)', () => {
      const audit = auditFor('somepkg', 'GHSA-low1', [], 'low');
      const { excepted, blocking } = classifyAdvisories(audit, []);
      expect(excepted).toHaveLength(0);
      expect(blocking).toHaveLength(0); // below threshold → not counted at all
    });
  });

  describe('stale detection', () => {
    it('warns on a per-GHSA exception whose advisory no longer fires', () => {
      const audit = auditFor('somepkg', 'GHSA-zzzz');
      const { stale } = classifyAdvisories(audit, [{ id: 'GHSA-stale-eeee', package: 'otherpkg', ...BASE_EXC }]);
      expect(stale).toHaveLength(1);
    });

    it('warns on a location-scoped exception that matches nothing', () => {
      const audit = auditFor('somepkg', 'GHSA-zzzz', ['node_modules/somepkg']);
      const { stale } = classifyAdvisories(audit, [
        { package: 'undici', locationContains: '@earendil-works/pi-coding-agent', ...BASE_EXC },
      ]);
      expect(stale).toHaveLength(1);
    });

    it('does NOT warn on a location-scoped exception that still matches', () => {
      const audit = auditFor('undici', 'GHSA-zzzz', ['node_modules/@earendil-works/pi-coding-agent/node_modules/undici']);
      const { stale } = classifyAdvisories(audit, [
        { package: 'undici', locationContains: '@earendil-works/pi-coding-agent', ...BASE_EXC },
      ]);
      expect(stale).toHaveLength(0);
    });
  });

  describe('validateExceptions', () => {
    it('accepts both per-GHSA and location-scoped entries', () => {
      expect(() =>
        validateExceptions([
          { id: 'GHSA-x', package: 'p', ...BASE_EXC },
          { package: 'p', locationContains: 'loc', ...BASE_EXC },
        ]),
      ).not.toThrow();
    });

    it('rejects an entry that is neither per-GHSA nor location-scoped', () => {
      expect(() => validateExceptions([{ reason: 'r', clearsWhen: 'c', reviewed: 'd' }])).toThrow();
    });

    it('rejects an entry missing a required justification field', () => {
      expect(() => validateExceptions([{ id: 'GHSA-x', package: 'p', reason: 'r' }])).toThrow();
    });
  });

  describe('locationMatch (direct)', () => {
    const locExc = [{ package: 'undici', locationContains: '@earendil-works/pi-coding-agent' }];
    it('returns the exception on a scope-only match', () => {
      const m = locationMatch(
        { packages: new Set(['undici']), nodes: new Set(['node_modules/@earendil-works/pi-coding-agent/node_modules/undici']) },
        locExc,
      );
      expect(m).toBeDefined();
    });
    it('returns undefined when a remediable copy is present', () => {
      const m = locationMatch(
        { packages: new Set(['undici']), nodes: new Set(['node_modules/@earendil-works/pi-coding-agent/node_modules/undici', 'node_modules/jsdom/node_modules/undici']) },
        locExc,
      );
      expect(m).toBeUndefined();
    });
  });
});
